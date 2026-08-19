/**
 * POST /api/game/tick — 制限時間の締め切りを起こす
 *
 * 旧: サーバ内の setTimeout(() => room.forceResolve('time'), timerSec * 1000)
 *
 * Vercel Functions はリクエストの外で動き続けられないため、タイマーを持てません。
 * そこで先生の画面が、制限時間になった時点でこのルートを1回だけ叩きます。
 *
 * 安全のための決まりごと:
 *   - 締め切るかどうかを判断するのは **必ずサーバ**（lib/game.ts の tickDeadline）。
 *     クライアントは「時間になったかもしれません」と伝えるだけです。
 *     早く叩いても、まだ時刻が来ていなければ何も起きません。
 *   - 先生の画面が閉じていても、次に誰かが操作した時点で締め切られます
 *     （mutateRoom がすべての操作の前に tickDeadline を通すため）。
 */

import { readBody, json, apiError, handleUnexpected, viewerOf, normalizeCode, str } from '@/lib/api';
import { mutateRoom } from '@/lib/store';
import { snapshot } from '@/lib/game';
import type { Viewer } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    const token = str(body.token, 64);

    // mutateRoom は本体の処理より先に必ず tickDeadline を実行するので、
    // ここでは「何もしない操作」を渡すだけで締め切りの判定が行われます。
    const outcome = await mutateRoom<Viewer>(code, ({ state }) => {
      const viewer = viewerOf(state, token);
      if (!viewer) return { ok: false, error: 'ルームに接続していません。', code: 'notInRoom' };
      return { ok: true, value: viewer, events: [] };
    });

    if (!outcome.ok) {
      return apiError(outcome.error, outcome.code, outcome.code === 'noRoom' ? 404 : 400);
    }

    return json({ state: snapshot(outcome.state, outcome.rules, outcome.value) });
  } catch (err) {
    return handleUnexpected(err);
  }
}
