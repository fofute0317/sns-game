/**
 * GET /api/rulesets — 先生のルーム作成画面に出す、ルールセットの一覧
 *
 * 旧: GET /api/rulesets（server/index.js）
 * 中身は同じですが、config/ を fs で読む代わりにビルド時 import を使います（lib/rules.ts）。
 */

import { json, handleUnexpected } from '@/lib/api';
import { listRulesets } from '@/lib/rules';
import { STRATEGIES, STRATEGY_IDS } from '@/lib/bots';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return json({
      rulesets: listRulesets(),
      strategies: STRATEGY_IDS.map((id) => STRATEGIES[id]),
    });
  } catch (err) {
    return handleUnexpected(err);
  }
}
