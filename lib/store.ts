/**
 * ルームの保管庫（Supabase Postgres 版）。
 *
 * ★ 移行メモ: 旧 server/store.js（Map + data/rooms.json）の完全な置き換えです。
 *
 *   旧: メモリ上の Map に Room インスタンスを持ち、800ms ごとに JSON へ保存
 *   新: rooms テーブルの1行（game_state JSONB）が唯一の正
 *
 *   サーバレスでいちばん危ないのは「同時更新で上書きが起きる」ことです。
 *   例: 5人の生徒が同時に「決定する」を押すと、5つの関数が同時に走ります。
 *       素朴に「読んで→書く」と、最後の1件以外が消えます。
 *
 *   対策として version 列を使った楽観ロック（CAS: compare-and-swap）を入れています。
 *     UPDATE rooms SET ..., version = version + 1 WHERE id = ? AND version = ?
 *   更新できた行が0件なら、誰かが先に更新したということなので、
 *   読み直して最初からやり直します（最大 MAX_RETRIES 回）。
 *
 *   ゲームの状態遷移（lib/game.ts）は純粋関数なので、やり直しても副作用がありません。
 */

import { supabaseAdmin, broadcast } from './supabase';
import { loadRuleset } from './rules';
import { rulesFor, newRoomCode, tickDeadline, createRoomState } from './game';
import { scoreProjection } from './scoring';
import { channelFor } from './realtime';
import type { RoomState, Ruleset, GameEventType } from './types';

const MAX_RETRIES = 6;
const ROOM_TTL_HOURS = 6;

export interface RoomRow {
  id: string;
  room_code: string;
  teacher_id: string;
  status: string;
  current_round: number;
  game_state: RoomState;
  version: number;
  rule_id: string;
}

export interface EmitEvent {
  type: GameEventType;
  payload?: Record<string, unknown>;
}

export type MutationOutcome<T> =
  | { ok: false; error: string; code?: string }
  | { ok: true; value: T; events?: EmitEvent[] };

export type Mutation<T> = (ctx: { state: RoomState; rules: Ruleset }) => MutationOutcome<T>;

export type MutateResult<T> =
  | { ok: false; error: string; code: string }
  | { ok: true; value: T; state: RoomState; rules: Ruleset; row: RoomRow };

const SELECT_COLS = 'id, room_code, teacher_id, status, current_round, game_state, version, rule_id';

/* ------------------------------------------------------------------ 読み取り */

export async function getRoomRow(code: string): Promise<RoomRow | null> {
  const normalized = String(code || '').trim();
  if (!normalized) return null;

  const { data, error } = await supabaseAdmin()
    .from('rooms')
    .select(SELECT_COLS)
    .eq('room_code', normalized)
    .maybeSingle();

  if (error) throw new Error(`ルームの読み込みに失敗しました: ${error.message}`);
  return (data as RoomRow | null) ?? null;
}

/** ルーム + 適用済みルール（需要モード反映済み）をまとめて取る */
export async function getRoom(
  code: string
): Promise<{ row: RoomRow; state: RoomState; rules: Ruleset } | null> {
  const row = await getRoomRow(code);
  if (!row) return null;
  const state = row.game_state;
  const rules = rulesFor(loadRuleset(state.ruleId || row.rule_id), state);
  return { row, state, rules };
}

/* ------------------------------------------------------------------ 作成 */

export async function createRoom({
  rulesetId = 'mvp',
  options = {},
}: {
  rulesetId?: string;
  options?: Record<string, unknown>;
}): Promise<{ row: RoomRow; state: RoomState; rules: Ruleset }> {
  const baseRules = loadRuleset(rulesetId);

  // ルームコードは6桁の数字。まれに衝突するので、unique 制約に任せて数回試す。
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newRoomCode(`${Date.now()}-${attempt}`);
    const state = createRoomState({ code, rules: baseRules, options: options as never });

    const { data, error } = await supabaseAdmin()
      .from('rooms')
      .insert({
        room_code: code,
        teacher_id: state.teacherToken,
        status: state.phase,
        current_round: state.round,
        game_state: state,
        rule_id: state.ruleId,
        version: 1,
      })
      .select(SELECT_COLS)
      .single();

    if (!error && data) {
      const row = data as RoomRow;
      await logEvents(row.id, [{ type: 'STATE_CHANGED', payload: { reason: 'ROOM_CREATED' } }]);
      return { row, state, rules: rulesFor(baseRules, state) };
    }

    // 23505 = unique_violation（コード衝突）。それ以外は本当のエラー。
    if (error && error.code !== '23505') {
      throw new Error(`ルームの作成に失敗しました: ${error.message}`);
    }
    lastError = new Error(error?.message || 'unique violation');
  }
  throw new Error(`ルームコードを発行できませんでした。${lastError ? `(${lastError.message})` : ''}`);
}

/* ------------------------------------------------------------------ 更新（CAS） */

/**
 * ルームを安全に更新する。
 *
 * mutation は「今の状態」を受け取り、その場で書き換えて結果を返します。
 * 途中で他のリクエストが割り込んで version が変わっていた場合は、
 * 状態を読み直して mutation をもう一度最初から実行します。
 */
export async function mutateRoom<T>(code: string, mutation: Mutation<T>): Promise<MutateResult<T>> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const loaded = await getRoom(code);
    if (!loaded) {
      return { ok: false, error: 'そのルーム番号は見つかりませんでした。番号を確認してください。', code: 'noRoom' };
    }
    const { row, state, rules } = loaded;

    // 制限時間の経過を、実際の操作より先に処理する（旧実装の setTimeout の代わり）
    const timedOut = tickDeadline(state, rules);

    const outcome = mutation({ state, rules });

    if (!outcome.ok) {
      // 操作自体は失敗でも、時間切れの締め切りが起きていたなら保存しておく
      if (timedOut) {
        await persist(row, state, [{ type: 'ROUND_UPDATED', payload: { closedBy: 'time' } }]).catch(() => {});
      }
      return { ok: false, error: outcome.error, code: outcome.code || 'badRequest' };
    }

    const events: EmitEvent[] = [
      ...(timedOut ? [{ type: 'ROUND_UPDATED' as GameEventType, payload: { closedBy: 'time' } }] : []),
      ...(outcome.events || []),
    ];

    const saved = await persist(row, state, events);
    if (saved) {
      return { ok: true, value: outcome.value, state, rules, row: { ...row, game_state: state, version: row.version + 1 } };
    }
    // version が進んでいた → 読み直してやり直す
  }

  return {
    ok: false,
    error: 'ほかの操作と重なりました。もう一度お試しください。',
    code: 'conflict',
  };
}

/**
 * CAS で1回だけ保存を試みる。
 * @returns 保存できたら true、version が競合したら false
 */
async function persist(row: RoomRow, state: RoomState, events: EmitEvent[]): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('rooms')
    .update({
      game_state: state,
      status: state.closed ? 'closed' : state.phase,
      current_round: state.round,
      version: row.version + 1,
    })
    .eq('id', row.id)
    .eq('version', row.version) // ← ここが楽観ロック
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`ルームの保存に失敗しました: ${error.message}`);
  if (!data) return false; // 0件更新 = 競合

  const nextVersion = row.version + 1;

  // 保存できてから、写しの更新・ログ・配信を行う。
  // ここが失敗してもゲームは進むので、まとめて待ちつつ例外は握りつぶす。
  await Promise.allSettled([
    syncPlayers(row.id, state),
    logEvents(row.id, events),
    fanout(state.code, nextVersion, events),
  ]);

  return true;
}

/* ------------------------------------------------------------------ 派生テーブル */

/**
 * players テーブルを game_state に合わせる（読み取り・分析用の写し）。
 * ゲーム進行はこのテーブルを読まないので、失敗しても進行は壊れません。
 */
async function syncPlayers(roomId: string, state: RoomState): Promise<void> {
  const rows = scoreProjection(state).map((p) => ({ ...p, room_id: roomId }));
  const db = supabaseAdmin();

  if (rows.length) {
    const { error } = await db.from('players').upsert(rows, { onConflict: 'room_id,player_id' });
    if (error) console.warn('[store] players の同期に失敗:', error.message);
  }

  // 退出した生徒の行を消す。
  // .not('player_id', 'in', '("a","b")') は PostgREST の player_id=not.in.("a","b") になります。
  // 値の形（丸かっこ＋ダブルクォート）は PostgREST の書式なので、崩さないでください。
  // keep が空のときは条件なしの delete（＝そのルームの全員を削除）になります。
  const keep = rows.map((r) => r.player_id);
  const del = db.from('players').delete().eq('room_id', roomId);
  const { error: delError } = keep.length
    ? await del.not('player_id', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`)
    : await del;
  if (delError) console.warn('[store] players の掃除に失敗:', delError.message);
}

async function logEvents(roomId: string, events: EmitEvent[]): Promise<void> {
  if (!events.length) return;
  const { error } = await supabaseAdmin()
    .from('game_events')
    .insert(events.map((e) => ({ room_id: roomId, event_type: e.type, payload: e.payload || {} })));
  if (error) console.warn('[store] game_events の記録に失敗:', error.message);
}

/* ------------------------------------------------------------------ Realtime 配信 */

/**
 * 変更をルームの全員へ知らせる。
 *
 * 状態そのものは載せません。生徒ごとに見えてよい範囲が違う（自分の選択は自分だけ）ため、
 * 「変わったよ」という合図だけを配り、各自が /api/rooms/state を取りに行きます。
 * 詳しくは lib/realtime.ts のコメントを参照してください。
 *
 * イベントが空の更新は、**何も配信しません**。
 * 生徒が選択肢を押すたびに走る draft の保存がこれに当たります。
 * 下書きは本人の画面にしか関係しないので、ここで全員に合図を流すと
 * 「1人が1回押すたびに、部屋の全員が状態を取り直す」ことになってしまいます。
 * 全員に知らせたい更新は、呼び出し側が明示的にイベントを積んでください
 * （種類が特に無ければ STATE_CHANGED）。
 */
async function fanout(code: string, version: number, events: EmitEvent[]): Promise<void> {
  if (!events.length) return;
  const topic = channelFor(code);
  for (const e of events) {
    await broadcast(topic, e.type, { ...(e.payload || {}), roomCode: code, version, at: Date.now() });
  }
}

/** ルーム外から直接1件流したいとき（退出通知など） */
export async function emit(code: string, type: GameEventType, payload: Record<string, unknown> = {}) {
  await broadcast(channelFor(code), type, { ...payload, roomCode: code, at: Date.now() });
}

/* ------------------------------------------------------------------ 削除・後片付け */

export async function deleteRoom(code: string): Promise<void> {
  const { error } = await supabaseAdmin().from('rooms').delete().eq('room_code', code);
  if (error) throw new Error(`ルームの削除に失敗しました: ${error.message}`);
}

/** 6時間さわられていないルームを片付ける（/api/cron/sweep から呼ばれる） */
export async function sweepStaleRooms(hours = ROOM_TTL_HOURS): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('cleanup_stale_rooms', { max_idle_hours: hours });
  if (error) throw new Error(`後片付けに失敗しました: ${error.message}`);
  return Number(data ?? 0);
}
