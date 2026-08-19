/**
 * POST /api/game/submit — 生徒が「この内容で決定する」を押す
 *
 * 旧: WebSocket メッセージ { t: 'submit' }
 *
 * リクエスト  { code, token, decision: { cacao:'fairtrade', price:'mid', ... } }
 * レスポンス  { state }  ← 自分用スナップショット
 *
 * ■ 受け取るのは「どれを選んだか」だけ ■
 *   金額・販売数・点数はブラウザから一切受け取りません。すべてサーバで計算します。
 *   （旧実装からの重要な方針。書き換え・端末差による食い違いを根本から防ぐため）
 *
 * ■ 同時提出について ■
 *   5人が同時に押しても、lib/store.ts の楽観ロックで1件ずつ確実に反映されます。
 *   全員の提出がそろった瞬間に、この関数の中でラウンドが解決されます。
 */

import { readBody, json, apiError, handleUnexpected, viewerOf, normalizeCode, str } from '@/lib/api';
import { mutateRoom } from '@/lib/store';
import { submit, snapshot } from '@/lib/game';
import type { EmitEvent } from '@/lib/store';
import type { Viewer } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    const token = str(body.token, 64);

    const outcome = await mutateRoom<Viewer>(code, ({ state, rules }) => {
      const viewer = viewerOf(state, token);
      if (!viewer) return { ok: false, error: 'ルームに接続していません。', code: 'notInRoom' };
      if (viewer.role !== 'player' || !viewer.playerId) {
        return { ok: false, error: 'この操作はできません。', code: 'forbidden' };
      }

      const before = state.phase;
      const r = submit(state, rules, viewer.playerId, body.decision);
      if (!r.ok) return { ok: false, error: r.error, code: 'submitFailed' };

      const events: EmitEvent[] = [
        {
          type: 'ANSWER_SUBMITTED',
          payload: {
            playerId: viewer.playerId,
            submittedCount: state.order.filter((id) => state.players[id]?.submitted).length,
            playerCount: state.order.length,
          },
        },
      ];

      // 自分の提出で全員そろい、ラウンドが解決された場合
      if (before === 'decision' && state.phase === 'result') {
        events.push({ type: 'ROUND_UPDATED', payload: { round: state.round, closedBy: 'all' } });
        events.push({ type: 'SCORE_UPDATED', payload: { round: state.round } });
      }

      return { ok: true, value: viewer, events };
    });

    if (!outcome.ok) {
      const status = outcome.code === 'noRoom' ? 404 : outcome.code === 'forbidden' ? 403 : 400;
      return apiError(outcome.error, outcome.code, status);
    }

    return json({ state: snapshot(outcome.state, outcome.rules, outcome.value) });
  } catch (err) {
    return handleUnexpected(err);
  }
}
