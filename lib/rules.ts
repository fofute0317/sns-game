/**
 * ルールセットの読み込み・継承・検証。
 *
 * ★ 移行メモ（重要）
 *   旧 server/rules.js は config/ を fs.readdirSync / fs.readFileSync で読んでいました。
 *   Vercel Functions にはファイルシステムの読み書きを前提にできないため、
 *   JSON を **ビルド時に import** する方式に変えています（tsconfig の resolveJsonModule）。
 *
 *   - 継承（extends）の解決、検証（validateRules）のロジックは旧実装のままです。
 *   - ルールを1つ増やすときは config/rules.xxx.json を作り、下の RAW_RULESETS に1行足します。
 *   - 数値だけを変えたいときは、これまでどおり JSON を編集して再デプロイするだけです。
 */

import rulesMvp from '../config/rules.mvp.json';
import rulesElementary from '../config/rules.elementary.json';
import rulesSpec from '../config/rules.spec.json';
import companiesJson from '../config/companies.json';
import newsJson from '../config/news.json';
import type { Ruleset } from './types';

/** config/ にあるルールセット。ファイル名 → 中身。 */
const RAW_RULESETS: Record<string, any> = {
  'rules.mvp.json': rulesMvp,
  'rules.elementary.json': rulesElementary,
  'rules.spec.json': rulesSpec,
};

export interface CompaniesConfig {
  list: Array<{ name: string; color: string; icon: string }>;
  botNames?: string[];
}

export const companies = companiesJson as unknown as CompaniesConfig;
export const news = newsJson as unknown as { items?: Array<Record<string, unknown>> };

/* ------------------------------------------------------------------ 継承のマージ */

const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const identityOf = (v: unknown) => (isObject(v) ? (v.id ?? v.key) : undefined);

function mergeArrays(base: any[], over: any[]): any[] {
  const keyed =
    base.length > 0 &&
    base.every((x) => identityOf(x) !== undefined) &&
    over.every((x) => identityOf(x) !== undefined);
  if (!keyed) return over; // id を持たない配列（effects など）は丸ごと置き換え
  const out = base.slice();
  for (const item of over) {
    const i = out.findIndex((x) => identityOf(x) === identityOf(item));
    if (i >= 0) out[i] = deepMerge(out[i], item);
    else out.push(item);
  }
  return out;
}

function deepMerge(base: any, over: any): any {
  if (over === undefined) return base;
  if (Array.isArray(base) && Array.isArray(over)) return mergeArrays(base, over);
  if (isObject(base) && isObject(over)) {
    const out: Record<string, any> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return over;
}

/** 'mvp' / 'rules.mvp.json' のどちらの書き方でも受け付ける */
function fileNameOf(name: string): string {
  return name.endsWith('.json') ? name : `rules.${name}.json`;
}

/* ------------------------------------------------------------------ 読み込み */

const cache = new Map<string, Ruleset>();

/** ルールセットを1つ読み込む（extends を解決済み・検証済み） */
export function loadRuleset(name = 'mvp', seen = new Set<string>()): Ruleset {
  const file = fileNameOf(String(name || 'mvp'));

  // extends の解決中（再帰呼び出し）は seen が増えていくので、
  // 「入口の呼び出しかどうか」を最初に確定させておく。
  // これを後から seen.size で判定すると、継承つきのルールが永久にキャッシュされない。
  const isEntryPoint = seen.size === 0;

  const cached = cache.get(file);
  if (cached && isEntryPoint) return cached;

  const raw = RAW_RULESETS[file];
  if (!raw) {
    throw new Error(`ルールファイルが見つかりません: config/${file}`);
  }
  if (seen.has(file)) {
    throw new Error(`ルールの extends が循環しています: ${[...seen, file].join(' -> ')}`);
  }
  seen.add(file);

  const merged: Record<string, any> = raw.extends
    ? deepMerge(loadRuleset(raw.extends, seen), raw)
    : structuredClone(raw);
  delete merged.extends;
  merged.sourceFile = file;

  const validated = validateRules(merged as Ruleset);
  if (isEntryPoint) cache.set(file, validated);
  return validated;
}

export interface RulesetSummary {
  id: string;
  label: string;
  file: string;
  rounds?: number;
  note?: string;
  error?: string;
}

/** ルールセットの一覧（先生の作成画面で選ばせる） */
export function listRulesets(): RulesetSummary[] {
  return Object.keys(RAW_RULESETS)
    .map((f): RulesetSummary => {
      try {
        const r = loadRuleset(f);
        return { id: r.id, label: r.label, file: f, rounds: r.game.rounds, note: (r.note as string) || '' };
      } catch (err) {
        return { id: f, label: `(読み込みエラー) ${f}`, file: f, error: String((err as Error).message) };
      }
    })
    .sort((a, b) => (a.id === 'mvp' ? -1 : b.id === 'mvp' ? 1 : a.id.localeCompare(b.id)));
}

/* ------------------------------------------------------------------ 検証 */

/**
 * ルールの整合性チェック。問題があれば理由つきで throw する。
 *
 * 旧実装ではサーバ起動時に全ルールを検証して「起動しない」ことで気づけるようにしていました。
 * サーバレスには起動時がないため、代わりに次の2か所で守ります。
 *   1) ビルド時: scripts の typecheck / test（test/rules.test.js が全ルールを読む）
 *   2) 実行時 : /api/rulesets が壊れたルールを error つきで返す
 */
export function validateRules(r: Ruleset): Ruleset {
  const errors: string[] = [];
  const req = (cond: unknown, msg: string) => {
    if (!cond) errors.push(msg);
  };

  req(r.id, 'id が必要です');
  req(isObject(r.game), 'game が必要です');
  if (isObject(r.game)) {
    req(Number.isInteger(r.game.rounds) && r.game.rounds > 0, 'game.rounds は1以上の整数にしてください');
    req(typeof r.game.startingFunds === 'number', 'game.startingFunds は数値にしてください');
    req(r.game.minPlayers >= 1, 'game.minPlayers は1以上にしてください');
    req(r.game.maxPlayers >= r.game.minPlayers, 'game.maxPlayers は minPlayers 以上にしてください');
  }

  req(isObject(r.demand), 'demand が必要です');
  if (isObject(r.demand)) {
    req(typeof r.demand.base === 'number' && r.demand.base > 0, 'demand.base は正の数にしてください');
    req(
      r.demand.randomness >= 0 && r.demand.randomness < 1,
      'demand.randomness は 0以上1未満にしてください（例: 0.06 で ±6%）'
    );
  }

  req(Array.isArray(r.decisions) && r.decisions.length > 0, 'decisions が必要です');
  const keys = new Set<string>();
  let priceGroups = 0;
  for (const g of r.decisions || []) {
    req(g.key, 'decisions[].key が必要です');
    req(!keys.has(g.key), `decisions[].key が重複しています: ${g.key}`);
    keys.add(g.key);
    req(['material', 'price', 'cost'].includes(g.kind), `decisions[${g.key}].kind は material/price/cost のいずれか`);
    req(Array.isArray(g.options) && g.options.length > 0, `decisions[${g.key}].options が空です`);
    if (g.kind === 'price') priceGroups++;
    const ids = new Set<string>();
    for (const o of g.options || []) {
      req(o.id, `decisions[${g.key}] の選択肢に id が必要です`);
      req(!ids.has(o.id), `decisions[${g.key}] の選択肢 id が重複: ${o.id}`);
      ids.add(o.id);
      if (g.kind === 'material') {
        req(typeof o.unitCost === 'number', `decisions[${g.key}].${o.id}.unitCost が必要です`);
        req(!!o.tier, `decisions[${g.key}].${o.id}.tier が必要です`);
      }
      if (g.kind === 'price') {
        req(typeof o.unitPrice === 'number', `decisions[${g.key}].${o.id}.unitPrice が必要です`);
      }
      if (g.kind === 'cost') {
        req(typeof o.cost === 'number', `decisions[${g.key}].${o.id}.cost が必要です`);
      }
    }
    const defaults = (g.options || []).filter((o) => o.default);
    req(defaults.length <= 1, `decisions[${g.key}] の default が複数あります`);
  }
  req(priceGroups === 1, 'kind:"price" の決定項目はちょうど1つにしてください');

  req(isObject(r.events) && Array.isArray(r.events.list) && r.events.list.length > 0, 'events.list が必要です');
  for (const e of r.events?.list || []) {
    req(e.id, 'events.list[].id が必要です');
    for (const eff of e.effects || []) {
      req(['materialCost', 'demand'].includes(eff.type), `イベント ${e.id}: effects[].type は materialCost/demand`);
      req(typeof eff.mul === 'number' && eff.mul >= 0, `イベント ${e.id}: effects[].mul は0以上の数値`);
    }
  }

  req(isObject(r.scoring?.weights), 'scoring.weights が必要です');
  if (isObject(r.scoring?.weights)) {
    const w = r.scoring.weights;
    const sum = (w.profit || 0) + (w.producer || 0) + (w.society || 0);
    req(Math.abs(sum - 1) < 1e-6, `scoring.weights の合計が1になっていません（現在 ${sum}）`);
  }

  if (errors.length) {
    throw new Error(
      `ルール「${r.sourceFile || r.id}」に問題があります:\n` + errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return r;
}
