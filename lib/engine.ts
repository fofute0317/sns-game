/**
 * ゲームエンジン（純粋関数のみ）
 *
 * 設計方針
 *  - ここには通信・DB・DOM の知識を一切入れない。入力 → 出力の計算だけを行う。
 *  - ルール（価格・効果・点数・イベント）は config/rules.*.json 側にあり、
 *    このファイルには「数値」を書かない。数値を変えたいときは JSON だけを触る。
 *  - 乱数はシード固定。同じ入力なら必ず同じ結果になる。
 *
 * ★ 移行メモ: 旧 shared/engine.js の逐語移植です。計算式・丸め・順序は一切変えていません。
 *    Vercel Functions（サーバ）・ブラウザ・テスト・シミュレータの4か所から使われます。
 */

import { rngFor, jitter, shuffled, type Rng } from './rng';
import type {
  Ruleset,
  RuleDecisionGroup,
  RuleOption,
  RuleEvent,
  Decision,
  PlayerScore,
  RoundResult,
  Standings,
  StandingRow,
  Insight,
} from './types';

/* ------------------------------------------------------------------ *
 * ルールへのアクセサ（インデックスを持たず、都度探索する）
 * 選択肢は数個しかないので探索コストは無視できる。
 * そのぶんルールオブジェクトはそのまま JSON 化してブラウザに送れる。
 * ------------------------------------------------------------------ */

/** 実際に生徒が選ぶ決定項目（enabled:false は除外） */
export function activeDecisions(rules: Ruleset): RuleDecisionGroup[] {
  return rules.decisions.filter((d) => d.enabled !== false);
}

/** 無効化された項目も含めた全項目（計算には既定値として使われる） */
export function allDecisions(rules: Ruleset): RuleDecisionGroup[] {
  return rules.decisions;
}

export function findDecision(rules: Ruleset, key: string): RuleDecisionGroup | undefined {
  return rules.decisions.find((d) => d.key === key);
}

export function findOption(group: RuleDecisionGroup | undefined, id: string): RuleOption | undefined {
  if (!group) return undefined;
  return group.options.find((o) => o.id === id);
}

export function defaultOptionId(group: RuleDecisionGroup): string {
  const def = group.options.find((o) => o.default) || group.options[0];
  return def.id;
}

/** 全項目を既定値で埋めた決定 */
export function defaultDecision(rules: Ruleset): Decision {
  const d: Decision = {};
  for (const group of rules.decisions) d[group.key] = defaultOptionId(group);
  return d;
}

/**
 * クライアントから来た決定を必ず正しい形に整える。
 * 不正な値・欠けている値は既定値に落とす（＝サーバは絶対に例外を投げない）。
 */
export function sanitizeDecision(rules: Ruleset, input: unknown): Decision {
  const out: Decision = {};
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, string>;
  for (const group of rules.decisions) {
    const wanted = src[group.key];
    const ok = group.enabled !== false && findOption(group, wanted);
    out[group.key] = ok ? wanted : defaultOptionId(group);
  }
  return out;
}

/** 生徒が選ぶべき項目をすべて選び終えたか */
export function isDecisionComplete(rules: Ruleset, decision: Decision | null | undefined): boolean {
  if (!decision) return false;
  return activeDecisions(rules).every((g) => !!findOption(g, decision[g.key]));
}

/* ------------------------------------------------------------------ *
 * イベント
 * ------------------------------------------------------------------ */

export function findEvent(rules: Ruleset, id: string | undefined): RuleEvent {
  return rules.events.list.find((e) => e.id === id) || rules.events.list[0];
}

/**
 * 5ラウンド分のイベントを事前に決めておく（ゲーム開始時に1回だけ）。
 * 事前確定にしておくと、途中でサーバが再起動しても進行が変わらない。
 */
export function planEvents(rules: Ruleset, seed: string): string[] {
  const rounds = rules.game.rounds;
  const cfg = rules.events || ({ list: [] } as unknown as Ruleset['events']);
  const list = cfg.list || [];
  const quietId = list.some((e) => e.id === 'quiet') ? 'quiet' : list[0]?.id;

  if (cfg.mode === 'fixed' && Array.isArray(cfg.fixedOrder)) {
    const plan: string[] = [];
    for (let i = 0; i < rounds; i++) {
      plan.push(cfg.fixedOrder[i % cfg.fixedOrder.length] || quietId);
    }
    return plan;
  }

  const rng = rngFor(seed, 'events');
  // 1ラウンド目は「静かな年」にしてルールの理解に集中させる（設定で変更可）
  const startQuiet = cfg.firstRound === 'quiet';
  const pool = list.filter((e) => e.id !== quietId).map((e) => e.id);
  let bag = shuffled(rng, pool);
  const plan: string[] = [];

  for (let i = 0; i < rounds; i++) {
    if (i === 0 && startQuiet) {
      plan.push(quietId);
      continue;
    }
    if (!bag.length) bag = shuffled(rng, pool);
    // noRepeat:false のときは毎回引き直す（同じイベントが連続しうる）
    plan.push(cfg.noRepeat === false ? bag[Math.floor(rng() * bag.length)] : (bag.shift() as string));
  }
  return plan;
}

interface WhenCtx {
  tiers: string[];
  priceId: string | null;
  adId: string | null;
  giveId: string | null;
  adCost: number;
  giveCost: number;
}

/** イベント条件（when）の判定 */
function matchesWhen(when: Record<string, any> | undefined, ctx: WhenCtx): boolean {
  if (!when) return true;
  if (when.usesTier) {
    const want = ([] as string[]).concat(when.usesTier);
    if (!ctx.tiers.some((t) => want.includes(t))) return false;
  }
  if (when.allTiers) {
    const want = ([] as string[]).concat(when.allTiers);
    if (!ctx.tiers.length || !ctx.tiers.every((t) => want.includes(t))) return false;
  }
  if (when.priceIn && !when.priceIn.includes(ctx.priceId)) return false;
  // 選択肢のid で指定する書き方（推奨）。
  // 金額で指定すると、通貨や桁を変えたときに条件が壊れます。
  if (when.adIn && !when.adIn.includes(ctx.adId)) return false;
  if (when.giveIn && !when.giveIn.includes(ctx.giveId)) return false;
  if (when.adCostAtLeast != null && ctx.adCost < when.adCostAtLeast) return false;
  if (when.giveCostAtLeast != null && ctx.giveCost < when.giveCostAtLeast) return false;
  return true;
}

/** イベントによる仕入価格の倍率を適用 */
function unitCostWithEvent(slot: string, option: RuleOption, event: RuleEvent): number {
  let cost = option.unitCost || 0;
  for (const eff of event.effects || []) {
    if (eff.type !== 'materialCost') continue;
    if (eff.slot && eff.slot !== slot) continue;
    if (eff.tier && eff.tier !== option.tier) continue;
    cost *= eff.mul;
  }
  return cost;
}

/* ------------------------------------------------------------------ *
 * 1ラウンドの計算
 * ------------------------------------------------------------------ */

const round1 = (n: number) => Math.round(n * 10) / 10;
const roundTo = (n: number, digits: number) => {
  const f = Math.pow(10, digits || 0);
  return Math.round(n * f) / f;
};

/**
 * 1人分の「需要のかかり具合」を計算する（販売数の直前まで）。
 * 販売数そのものは、通常モードか競争モードかで決まり方が変わるため2段構えにする。
 */
function computeAttraction({
  rules,
  decision,
  event,
  rng,
}: {
  rules: Ruleset;
  decision: Decision;
  event: RuleEvent;
  rng: Rng;
}) {
  const factors: Record<string, number> = {};
  const tiers: string[] = [];
  let mul = 1;

  let unitPrice = 0;
  let unitCost = 0;
  let adCost = 0;
  let giveCost = 0;
  let producerGain = 0;
  let societyGain = 0;
  let ethical = 0;

  for (const group of rules.decisions) {
    const opt = findOption(group, decision[group.key]);
    if (!opt) continue;

    if (group.kind === 'material') {
      tiers.push(opt.tier as string);
      unitCost += unitCostWithEvent(group.slot || group.key, opt, event);
      ethical += opt.demand || 0;
      producerGain += opt.producer || 0;
      societyGain += opt.society || 0;
    } else if (group.kind === 'price') {
      unitPrice = opt.unitPrice || 0;
      factors.price = 1 + (opt.demand || 0);
      mul *= factors.price;
    } else if (group.kind === 'cost') {
      adCost += group.key === 'ad' ? opt.cost || 0 : 0;
      giveCost += group.key === 'give' ? opt.cost || 0 : 0;
      producerGain += opt.producer || 0;
      societyGain += opt.society || 0;
      if (opt.demand) {
        factors[group.key] = 1 + opt.demand;
        mul *= factors[group.key];
      }
    }
  }

  factors.ethical = 1 + ethical;
  mul *= factors.ethical;

  const priceGroup = rules.decisions.find((g) => g.kind === 'price');
  const ctx: WhenCtx = {
    tiers,
    priceId: priceGroup ? decision[priceGroup.key] : null,
    adId: decision.ad ?? null,
    giveId: decision.give ?? null,
    adCost,
    giveCost,
  };

  let eventMul = 1;
  const eventHits: unknown[] = [];
  for (const eff of event.effects || []) {
    if (eff.type !== 'demand') continue;
    if (!matchesWhen(eff.when, ctx)) continue;
    eventMul *= eff.mul;
    eventHits.push(eff);
  }
  factors.event = eventMul;
  mul *= eventMul;

  const luck = 1 + jitter(rng, rules.demand.randomness);
  factors.luck = luck;
  mul *= luck;

  return {
    attraction: Math.max(0, mul),
    factors,
    tiers,
    unitPrice,
    unitCost,
    adCost,
    giveCost,
    producerGain,
    societyGain,
    eventApplied: eventHits.length > 0,
  };
}

export interface Submission {
  playerId: string;
  decision: Decision;
  auto?: boolean;
}

/**
 * ラウンドを解決する。
 *
 * @returns プレイヤーごとの計算結果（提出順とは無関係に決定的）
 */
export function resolveRound({
  rules,
  roundIndex,
  eventId,
  submissions,
  seed,
}: {
  rules: Ruleset;
  roundIndex: number;
  eventId: string;
  submissions: Submission[];
  seed: string;
}): RoundResult[] {
  const event = findEvent(rules, eventId);
  const digits = rules.game.quantity?.decimals ?? 1;

  // 1) まず全員の魅力度を出す（プレイヤーIDでソートして計算順を固定）
  const ordered = submissions.slice().sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
  const pre = ordered.map((s) => {
    const rng = rngFor(seed, 'r', roundIndex, s.playerId);
    const decision = sanitizeDecision(rules, s.decision);
    return { ...computeAttraction({ rules, decision, event, rng }), playerId: s.playerId, decision, auto: !!s.auto };
  });

  // 2) 販売数を決める
  const mode = rules.demand.mode === 'share' ? 'share' : 'independent';
  let quantities: number[];
  if (mode === 'share') {
    const sens = rules.demand.share?.sensitivity ?? 1;
    const totalDemand = (rules.demand.share?.perPlayer ?? rules.demand.base) * pre.length;
    const weights = pre.map((p) => Math.pow(Math.max(p.attraction, 1e-6), sens));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    quantities = weights.map((w) => (totalDemand * w) / sum);
  } else {
    quantities = pre.map((p) => rules.demand.base * p.attraction);
  }

  // 3) お金の計算
  return pre.map((p, i) => {
    const quantity = Math.max(rules.demand.floor ?? 0, roundTo(quantities[i], digits));
    const revenue = Math.round(p.unitPrice * quantity);
    const materialCost = Math.round(p.unitCost * quantity);
    const profit = revenue - materialCost - p.adCost - p.giveCost;
    return {
      playerId: p.playerId,
      decision: p.decision,
      auto: p.auto,
      eventId: event.id,
      quantity,
      unitPrice: p.unitPrice,
      unitCost: round1(p.unitCost),
      revenue,
      materialCost,
      adCost: p.adCost,
      giveCost: p.giveCost,
      profit,
      producerGain: p.producerGain,
      societyGain: p.societyGain,
      factors: {
        price: round1(p.factors.price ?? 1),
        ad: round1(p.factors.ad ?? 1),
        ethical: round1(p.factors.ethical ?? 1),
        event: round1(p.factors.event ?? 1),
        luck: Math.round((p.factors.luck ?? 1) * 100) / 100,
      },
      eventApplied: p.eventApplied,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 集計・ランキング
 * ------------------------------------------------------------------ */

export function initialPlayerScore(rules: Ruleset): PlayerScore {
  return {
    funds: rules.game.startingFunds,
    producer: 0,
    society: 0,
    totalProfit: 0,
  };
}

/** 1ラウンド分の結果をプレイヤーの累計に足す（非破壊） */
export function applyResult(score: PlayerScore, result: RoundResult): PlayerScore {
  return {
    funds: score.funds + result.profit,
    producer: score.producer + result.producerGain,
    society: score.society + result.societyGain,
    totalProfit: score.totalProfit + result.profit,
  };
}

/** 値の配列を 0〜100 に正規化する */
export function normalizeValues(values: number[], mode = 'minmax'): number[] {
  if (!values.length) return [];
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max === min) return values.map(() => 100);
  if (mode === 'relativeToMax') {
    const base = Math.min(0, min);
    return values.map((v) => (100 * (v - base)) / (max - base));
  }
  return values.map((v) => (100 * (v - min)) / (max - min));
}

/** 降順に並べて順位を振る（同点は同順位、次は飛ばす） */
function rankDesc<T extends Record<string, any>>(rows: T[], key: string): T[] {
  const sorted = rows.slice().sort((a, b) => b[key] - a[key]);
  let rank = 0;
  let prev: number | null = null;
  sorted.forEach((row, i) => {
    if (prev === null || row[key] !== prev) rank = i + 1;
    prev = row[key];
    (row as Record<string, any>).rank = rank;
  });
  return sorted;
}

/**
 * 最終（または途中）ランキングを計算する。
 */
export function computeStandings(
  rules: Ruleset,
  players: Array<{ id: string; name: string; company: string; score: PlayerScore }>
): Standings {
  const w = rules.scoring.weights;
  const mode = rules.scoring.normalization;

  const fundsArr = players.map((p) => p.score.funds);
  const prodArr = players.map((p) => p.score.producer);
  const socArr = players.map((p) => p.score.society);

  const nf = normalizeValues(fundsArr, mode);
  const np = normalizeValues(prodArr, mode);
  const ns = normalizeValues(socArr, mode);

  const rows = players.map((p, i) => {
    const parts = {
      profit: Math.round(nf[i] * w.profit * 10) / 10,
      producer: Math.round(np[i] * w.producer * 10) / 10,
      society: Math.round(ns[i] * w.society * 10) / 10,
    };
    return {
      id: p.id,
      name: p.name,
      company: p.company,
      funds: p.score.funds,
      producerPoints: p.score.producer,
      societyPoints: p.score.society,
      normalized: {
        profit: Math.round(nf[i] * 10) / 10,
        producer: Math.round(np[i] * 10) / 10,
        society: Math.round(ns[i] * 10) / 10,
      },
      parts,
      total: Math.round((parts.profit + parts.producer + parts.society) * 10) / 10,
    };
  });

  return {
    profit: rankDesc(rows.map((r) => ({ ...r, value: r.funds })), 'value') as StandingRow[],
    producer: rankDesc(rows.map((r) => ({ ...r, value: r.producerPoints })), 'value') as StandingRow[],
    society: rankDesc(rows.map((r) => ({ ...r, value: r.societyPoints })), 'value') as StandingRow[],
    total: rankDesc(rows.map((r) => ({ ...r, value: r.total })), 'value') as StandingRow[],
  };
}

/**
 * 授業のふりかえり用に「気づき」を自動生成する。
 * 例:「利益1位と総合1位が違いました」など、先生が話題にしやすい事実を出す。
 *
 * rules は今の実装では参照しませんが、旧 shared/engine.js と同じ引数の形を保っています
 * （ルールごとに文言を変える拡張がしやすいように、意図して残しています）。
 */
export function buildInsights(rules: Ruleset, standings: Standings): Insight[] {
  const out: Insight[] = [];
  const profitTop = standings.profit[0];
  const totalTop = standings.total[0];
  const producerTop = standings.producer[0];

  if (profitTop && totalTop) {
    if (profitTop.id !== totalTop.id) {
      out.push({
        type: 'flip',
        text: `利益で1位だったのは「${profitTop.company}」ですが、総合で1位になったのは「${totalTop.company}」でした。`,
        ask: 'なぜ順位が入れ替わったのでしょうか？',
      });
    } else {
      out.push({
        type: 'same',
        text: `「${totalTop.company}」は、利益でも総合でも1位でした。`,
        ask: '利益と社会への貢献を、どうやって両立させたのでしょうか？',
      });
    }
  }
  if (producerTop && profitTop && producerTop.id !== profitTop.id) {
    out.push({
      type: 'producer',
      text: `生産者への貢献がいちばん大きかったのは「${producerTop.company}」でした（利益は${
        standings.profit.find((r) => r.id === producerTop.id)?.rank ?? '-'
      }位）。`,
      ask: '生産者に多く支払うと、会社の利益はどうなりましたか？',
    });
  }
  const zeroProducer = standings.producer.filter((r) => r.value === 0);
  if (zeroProducer.length) {
    out.push({
      type: 'zero',
      text: `${zeroProducer.length}社は、生産者への貢献が0点でした。`,
      ask: 'その会社の商品を作っていた人たちは、この5年間どうだったと思いますか？',
    });
  }
  return out;
}
