/**
 * ルーム（1回の授業＝1ゲーム）の状態遷移。
 *
 * 重要な方針（旧 server/room.js から引き継ぎ）:
 *  - ゲームの状態と計算結果は「すべてサーバが持つ」。
 *    ブラウザから送られてくるのは「どれを選んだか」だけで、金額や点数は一切受け取らない。
 *  - 画面はサーバから配られた状態（スナップショット）を描くだけ。
 *    そのため、再接続・再読み込み・端末の入れ替えが起きても表示がズレない。
 *
 * ★ 移行メモ（設計の変更点はここだけ）
 *
 *   旧: class Room extends EventEmitter … メモリ上に生き続け、setTimeout を持っていた
 *   新: RoomState（ただの JSON）を受け取り、新しい RoomState を返す純粋関数の集まり
 *
 *   理由: Vercel Functions はリクエストが終わるとプロセスごと消えます。
 *         「生き続けるオブジェクト」も「タイマー」も持てません。
 *         そこで状態は Postgres の1行（rooms.game_state）に置き、
 *         関数は「今の状態 → 次の状態」を計算するだけにしました。
 *
 *   ゲームのルール・計算・進行順序は一切変えていません。
 *   タイマーとAIの手番の扱いだけ、下記のとおり置き換えています。
 *
 *     制限時間 : setTimeout → deadline（時刻）を保存し、
 *                リクエストのたびに tickDeadline() で経過を判定する
 *     AIの手番 : setTimeout（1.2〜3.8秒後） → 決定フェーズに入った時点で即時に確定
 *                （同じシード・同じ乱数列を使うので、選ぶ手は旧実装と完全に同一）
 */

import {
  planEvents,
  findEvent,
  resolveRound,
  initialPlayerScore,
  applyResult,
  sanitizeDecision,
  isDecisionComplete,
  defaultDecision,
  activeDecisions,
  emptyResearch,
  sanitizeResearch,
  scoreResearch,
  researchFields,
} from './engine';
import { standingsOf, insightsOf } from './scoring';
import { decideForBot, botThinkDelay } from './bots';
import { rngFor, token as makeToken, roomCode as makeRoomCode } from './rng';
import type { CompaniesConfig } from './rules';
import type {
  ResearchAnswers,
  RoomState,
  RoomPlayer,
  RoomOptions,
  Ruleset,
  Decision,
  Snapshot,
  Viewer,
  RuleEvent,
} from './types';

export const PHASE = {
  LOBBY: 'lobby',
  DECISION: 'decision',
  RESULT: 'result',
  FINAL: 'final',
} as const;

export const FINAL_STAGE = ['profit', 'total', 'reflect'] as const;

export type Outcome<T = RoomState> = { ok: true; state: T } | { ok: false; error: string };

const ok = (state: RoomState): Outcome => ({ ok: true, state });
const fail = (error: string): Outcome => ({ ok: false, error });

/* ================================================================== 生成 */

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** ルームコードを1つ作る（重複チェックは呼び出し側＝DBのunique制約） */
export function newRoomCode(salt: number | string = Date.now()): string {
  return makeRoomCode(rngFor('code', String(salt), Math.floor(Math.random() * 1e9)));
}

/**
 * ルールに需要モードを反映したコピーを返す。
 * （ルール本体は共有物なので書き換えない — 旧実装と同じ考え方）
 */
export function rulesFor(rules: Ruleset, state: RoomState): Ruleset {
  return { ...rules, demand: { ...rules.demand, mode: state.options.demandMode } };
}

export function createRoomState({
  code,
  rules,
  options = {},
  seed,
}: {
  code: string;
  rules: Ruleset;
  options?: Partial<RoomOptions>;
  seed?: string;
}): RoomState {
  const now = Date.now();
  const resolvedSeed = seed || `${code}-${now}-${Math.floor(Math.random() * 1e6)}`;

  const roomOptions: RoomOptions = {
    maxPlayers: clampInt(options.maxPlayers, rules.game.minPlayers, 8, rules.game.maxPlayers),
    demandMode: options.demandMode === 'share' ? 'share' : (rules.demand.mode as 'independent') || 'independent',
    timerSec: clampInt(options.timerSec, 0, 600, 0),
    autoAdvance: options.autoAdvance !== false, // 全員提出したら自動で締め切る
  };

  const state: RoomState = {
    code,
    ruleId: rules.id,
    seed: resolvedSeed,
    createdAt: now,
    updatedAt: now,
    options: roomOptions,
    teacherToken: makeToken(rngFor(resolvedSeed, 'teacher'), 24),
    teacherConnected: false,
    phase: PHASE.LOBBY,
    round: 0,
    finalStageIndex: 0,
    closed: false,
    deadline: null,
    eventPlan: [],
    rounds: [],
    order: [],
    players: {},
  };

  state.eventPlan = planEvents(rulesFor(rules, state), resolvedSeed);
  return state;
}

/* ================================================================== 参照 */

export const playerCount = (s: RoomState) => s.order.length;

export const activePlayers = (s: RoomState): RoomPlayer[] =>
  s.order.map((id) => s.players[id]).filter(Boolean);

export const submittedCount = (s: RoomState) => activePlayers(s).filter((p) => p.submitted).length;

export function findByToken(s: RoomState, token: string | null | undefined): RoomPlayer | null {
  if (!token) return null;
  for (const p of Object.values(s.players)) if (p.token === token) return p;
  return null;
}

export function canJoin(s: RoomState): { ok: boolean; message?: string } {
  if (s.closed) return { ok: false, message: 'このルームは終了しています。' };
  if (s.phase !== PHASE.LOBBY) return { ok: false, message: 'ゲームが始まっているため参加できません。' };
  if (playerCount(s) >= s.options.maxPlayers)
    return { ok: false, message: `定員（${s.options.maxPlayers}人）に達しています。` };
  return { ok: true };
}

function touch(s: RoomState): RoomState {
  s.updatedAt = Date.now();
  return s;
}

/* ================================================================== 参加まわり */

/** 同じ名前が既にいれば「たろう(2)」のようにする */
function uniqueName(s: RoomState, name: unknown): string {
  const base = String(name || '').trim().slice(0, 12) || 'プレイヤー';
  const taken = new Set(activePlayers(s).map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base}(${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}(${Date.now() % 1000})`;
}

export function addPlayer(
  s: RoomState,
  rules: Ruleset,
  companies: CompaniesConfig,
  { name, isBot = false, botStrategy = null }: { name?: string; isBot?: boolean; botStrategy?: string | null }
): { ok: true; state: RoomState; player: RoomPlayer } | { ok: false; error: string } {
  const check = canJoin(s);
  if (!check.ok) return { ok: false, error: check.message as string };

  const n = playerCount(s);
  const rng = rngFor(s.seed, 'player', n, Date.now());
  const id = `p${n + 1}_${makeToken(rng, 6)}`;
  const list = companies.list;
  const company = list[n % list.length];

  const player: RoomPlayer = {
    id,
    name: uniqueName(s, name),
    company: company.name,
    color: company.color,
    icon: company.icon,
    token: makeToken(rng, 24),
    isBot,
    botStrategy,
    connected: isBot,
    lastSeen: Date.now(),
    score: initialPlayerScore(rules),
    draft: defaultDecision(rules),
    submitted: false,
    submittedDecision: null,
    research: emptyResearch(),
  };
  s.players[id] = player;
  s.order.push(id);
  touch(s);
  return { ok: true, state: s, player };
}

export function removePlayer(s: RoomState, rules: Ruleset, playerId: string): RoomState {
  if (!s.players[playerId]) return s;
  delete s.players[playerId];
  s.order = s.order.filter((id) => id !== playerId);
  touch(s);
  maybeResolve(s, rules);
  return s;
}

/**
 * リサーチ（調べた調達情報）を保存する。
 *
 * ラウンドごとではなく「1ゲームに1つ」です。生産者や価格は年ごとに変わるものではなく、
 * 上位チームの回答をそのまま実際の仕入れ計画に使うための情報だからです。
 * 最終結果が出るまでは、いつでも書き直せます（調べながら埋めていく想定）。
 */
export function setResearch(
  s: RoomState,
  playerId: string,
  patch: Partial<ResearchAnswers>
): { ok: boolean; error?: string } {
  const p = s.players[playerId];
  if (!p) return { ok: false, error: 'プレイヤーが見つかりません。' };
  if (s.closed) return { ok: false, error: 'このルームは終了しています。' };

  // 部分更新（1項目ずつ保存されるため、既存の回答と混ぜてから整える）
  p.research = sanitizeResearch({ ...(p.research ?? emptyResearch()), ...(patch ?? {}) });
  touch(s);
  return { ok: true };
}

export function setConnected(s: RoomState, playerId: string, connected: boolean): RoomState {
  const p = s.players[playerId];
  if (!p) return s;
  p.connected = connected;
  p.lastSeen = Date.now();
  return touch(s);
}

/* ================================================================== 進行 */

export function start(s: RoomState, rules: Ruleset): Outcome {
  if (s.phase !== PHASE.LOBBY) return fail('すでに開始しています。');
  if (playerCount(s) < rules.game.minPlayers)
    return fail(`${rules.game.minPlayers}人以上で開始できます。`);
  s.round = 1;
  enterDecision(s, rules);
  return ok(s);
}

/**
 * 決定フェーズに入る。
 *
 * 旧実装との違いはAIの手番だけです。
 *  旧: emit('botTurn') → index.js が setTimeout(1.2〜3.8秒) で room.submit()
 *  新: ここで即時に確定する
 *
 * AIの「考えている時間」は演出であり、ゲームの結果には影響しません。
 * 乱数列を旧実装と完全に一致させるため、捨てる値になっても botThinkDelay() を
 * 同じ順序で必ず1回呼びます（これを省くと decideForBot が引く乱数がずれます）。
 */
function enterDecision(s: RoomState, rules: Ruleset): void {
  s.phase = PHASE.DECISION;
  for (const p of Object.values(s.players)) {
    p.submitted = false;
    p.submittedDecision = null;
    // 前ラウンドの選択を初期値として残す（毎回ゼロから選ばせない）
    p.draft = sanitizeDecision(rules, p.draft);
  }

  s.deadline = s.options.timerSec > 0 ? Date.now() + s.options.timerSec * 1000 : null;

  runBots(s, rules);
  touch(s);
  maybeResolve(s, rules);
}

/** AIプレイヤーの手番をまとめて確定する */
function runBots(s: RoomState, rules: Ruleset): void {
  const eventId = s.eventPlan[s.round - 1];
  for (const player of activePlayers(s)) {
    if (!player.isBot || player.submitted) continue;
    const rng = rngFor(s.seed, 'bot', s.round, player.id);
    botThinkDelay(rng); // ← 乱数列を旧実装と揃えるためだけに呼ぶ（戻り値は使わない）
    const decision = decideForBot({
      rules,
      roundIndex: s.round - 1,
      eventId,
      strategy: player.botStrategy,
      rng,
    });
    player.draft = sanitizeDecision(rules, { ...player.draft, ...decision });
    player.submitted = true;
    player.submittedDecision = { ...player.draft };
  }
}

export function setDraft(s: RoomState, rules: Ruleset, playerId: string, decision: Decision): boolean {
  const p = s.players[playerId];
  if (!p || s.phase !== PHASE.DECISION) return false;
  p.draft = sanitizeDecision(rules, { ...p.draft, ...decision });
  if (p.submitted) {
    // 提出後に変更したら提出は取り消し扱い（締め切り前なら何度でも変更できる）
    p.submitted = false;
    p.submittedDecision = null;
  }
  touch(s);
  return true;
}

export function submit(s: RoomState, rules: Ruleset, playerId: string, decision?: Decision): Outcome {
  const p = s.players[playerId];
  if (!p) return fail('プレイヤーが見つかりません。');
  if (s.phase !== PHASE.DECISION) return fail('いまは決定できません。');
  if (decision) p.draft = sanitizeDecision(rules, { ...p.draft, ...decision });
  if (!isDecisionComplete(rules, p.draft)) return fail('すべての項目を選んでください。');
  p.submitted = true;
  p.submittedDecision = { ...p.draft };
  touch(s);
  maybeResolve(s, rules);
  return ok(s);
}

export function unsubmit(s: RoomState, playerId: string): boolean {
  const p = s.players[playerId];
  if (!p || s.phase !== PHASE.DECISION) return false;
  p.submitted = false;
  p.submittedDecision = null;
  touch(s);
  return true;
}

function maybeResolve(s: RoomState, rules: Ruleset): void {
  if (s.phase !== PHASE.DECISION) return;
  if (!s.options.autoAdvance) return;
  if (playerCount(s) === 0) return;
  if (activePlayers(s).every((p) => p.submitted)) resolve(s, rules, 'all');
}

/** 先生が「締め切る」を押した／制限時間切れ */
export function forceResolve(s: RoomState, rules: Ruleset, reason: 'teacher' | 'time' = 'teacher'): Outcome {
  if (s.phase !== PHASE.DECISION) return fail('いまは締め切れません。');
  if (playerCount(s) === 0) return fail('参加者がいません。');
  resolve(s, rules, reason);
  return ok(s);
}

/**
 * 制限時間の経過をリクエストのたびに判定する。
 *
 * 旧実装のサーバ側 setTimeout の代わりです。
 * 誰かが画面を触る（＝APIを呼ぶ）たび、および先生画面が定期的に叩く
 * /api/game/tick で確認されるため、時間切れは確実に処理されます。
 *
 * @returns 締め切りが実際に発生したら true
 */
export function tickDeadline(s: RoomState, rules: Ruleset): boolean {
  if (s.phase !== PHASE.DECISION) return false;
  if (!s.deadline || Date.now() < s.deadline) return false;
  if (playerCount(s) === 0) return false;
  resolve(s, rules, 'time');
  return true;
}

function resolve(s: RoomState, rules: Ruleset, reason: 'all' | 'teacher' | 'time'): void {
  s.deadline = null;
  const eventId = s.eventPlan[s.round - 1];

  const submissions = activePlayers(s).map((p) => ({
    playerId: p.id,
    decision: (p.submitted ? p.submittedDecision : p.draft) as Decision,
    auto: !p.submitted,
  }));

  const results = resolveRound({
    rules,
    roundIndex: s.round - 1,
    eventId,
    submissions,
    seed: s.seed,
  });

  for (const r of results) {
    const p = s.players[r.playerId];
    if (!p) continue;
    p.score = applyResult(p.score, r);
    p.submitted = true;
    p.submittedDecision = r.decision;
    p.draft = { ...r.decision };
  }

  s.rounds.push({
    round: s.round,
    eventId,
    closedBy: reason,
    at: Date.now(),
    results,
  });

  s.phase = PHASE.RESULT;
  touch(s);
}

/** 先生が「次へ」を押す */
export function next(s: RoomState, rules: Ruleset): Outcome {
  if (s.phase === PHASE.RESULT) {
    if (s.round >= rules.game.rounds) {
      s.phase = PHASE.FINAL;
      s.finalStageIndex = 0;
    } else {
      s.round += 1;
      enterDecision(s, rules);
    }
    touch(s);
    return ok(s);
  }
  if (s.phase === PHASE.FINAL) {
    if (s.finalStageIndex < FINAL_STAGE.length - 1) {
      s.finalStageIndex += 1;
      touch(s);
      return ok(s);
    }
    return fail('これが最後の画面です。');
  }
  return fail('いまは進めません。');
}

export function back(s: RoomState): Outcome {
  if (s.phase === PHASE.FINAL && s.finalStageIndex > 0) {
    s.finalStageIndex -= 1;
    touch(s);
    return ok(s);
  }
  return fail('戻れません。');
}

/** 同じメンバーでもう一度（点数リセット、イベントは引き直し） */
export function restart(s: RoomState, rules: Ruleset): Outcome {
  s.seed = `${s.code}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  s.eventPlan = planEvents(rules, s.seed);
  s.rounds = [];
  s.round = 0;
  s.phase = PHASE.LOBBY;
  s.finalStageIndex = 0;
  s.deadline = null;
  for (const p of Object.values(s.players)) {
    p.score = initialPlayerScore(rules);
    p.draft = defaultDecision(rules);
    p.submitted = false;
    p.submittedDecision = null;
  }
  touch(s);
  return ok(s);
}

export function closeRoom(s: RoomState): RoomState {
  s.closed = true;
  s.deadline = null;
  return touch(s);
}

export function setOptions(s: RoomState, patch: { timerSec?: unknown; autoAdvance?: unknown }): RoomState {
  if (patch.timerSec != null) s.options.timerSec = Math.max(0, Math.min(600, Number(patch.timerSec) || 0));
  if (patch.autoAdvance != null) s.options.autoAdvance = !!patch.autoAdvance;
  return touch(s);
}

/* ================================================================== 画面に配る状態 */

function publicEvent(e: RuleEvent | undefined): Partial<RuleEvent> | null {
  if (!e) return null;
  return {
    id: e.id,
    name: e.name,
    icon: e.icon,
    headline: e.headline,
    body: e.body,
    learn: e.learn,
  };
}

/**
 * 画面へ配るスナップショット。旧 Room.snapshot() と同じ形・同じ内容です。
 *
 * 生徒には自分の draft しか入りません（他人の選択は締め切り前には見えない）。
 * このため Realtime では状態そのものを流さず、「変わったよ」という合図だけを流し、
 * 各自が自分用のスナップショットを取りに来る作りにしています（lib/realtime.ts）。
 */
export function snapshot(s: RoomState, rules: Ruleset, viewer: Viewer = { role: 'player' }): Snapshot {
  const standings = standingsOf(s, rules);
  const currentEventId = s.eventPlan[s.round - 1];
  const showEvent = s.phase === PHASE.DECISION || s.phase === PHASE.RESULT;

  const snap: Snapshot = {
    code: s.code,
    phase: s.phase,
    round: s.round,
    totalRounds: rules.game.rounds,
    ruleId: rules.id,
    ruleLabel: rules.label,
    demandMode: s.options.demandMode,
    maxPlayers: s.options.maxPlayers,
    minPlayers: rules.game.minPlayers,
    autoAdvance: s.options.autoAdvance,
    timerSec: s.options.timerSec,
    deadline: s.deadline,
    teacherConnected: s.teacherConnected,
    closed: s.closed,
    finalStage: FINAL_STAGE[s.finalStageIndex],
    finalStageIndex: s.finalStageIndex,
    finalStageCount: FINAL_STAGE.length,
    event: showEvent ? publicEvent(findEvent(rules, currentEventId)) : null,
    players: activePlayers(s).map((p) => ({
      id: p.id,
      name: p.name,
      company: p.company,
      color: p.color,
      icon: p.icon,
      connected: p.connected,
      isBot: p.isBot,
      submitted: p.submitted,
      funds: p.score.funds,
      producer: p.score.producer,
      society: p.score.society,
      researchCount: scoreResearch(rules, p.research).filledBonusCount,
    })),
    submittedCount: submittedCount(s),
    playerCount: playerCount(s),
    rounds: s.rounds.map((r) => ({
      round: r.round,
      eventId: r.eventId,
      closedBy: r.closedBy, // 'all' | 'teacher' | 'time'
      results: r.results,
    })),
    standings,
    insights: insightsOf(s, rules, standings),
    researchFields: researchFields(rules),
    updatedAt: s.updatedAt,
  };

  if (viewer.role === 'player' && viewer.playerId) {
    const me = s.players[viewer.playerId];
    if (me) {
      snap.you = {
        id: me.id,
        name: me.name,
        company: me.company,
        color: me.color,
        icon: me.icon,
        score: me.score,
        draft: me.draft,
        submitted: me.submitted,
        requiredKeys: activeDecisions(rules).map((d) => d.key),
        research: me.research ?? emptyResearch(),
        researchScore: scoreResearch(rules, me.research),
      };
    }
  }
  return snap;
}
