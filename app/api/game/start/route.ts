/**
 * POST /api/game/start — 先生がゲームを開始する
 *
 * 旧: WebSocket メッセージ { t: 'start' }
 *
 * リクエスト  { code, token }
 * レスポンス  { state }  ← 先生用スナップショット
 *
 * 開始と同時に、練習用AIの手はこの中で確定します（lib/game.ts の enterDecision）。
 */

import { readBody, json, apiError, handleUnexpected, viewerOf, normalizeCode, str } from '@/lib/api';
import { mutateRoom } from '@/lib/store';
import { start, snapshot } from '@/lib/game';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    const token = str(body.token, 64);

    const outcome = await mutateRoom(code, ({ state, rules }) => {
      const viewer = viewerOf(state, token);
      if (!viewer) return { ok: false, error: 'ルームに接続していません。', code: 'notInRoom' };
      if (viewer.role !== 'teacher') return { ok: false, error: '権限がありません。', code: 'forbidden' };

      const r = start(state, rules);
      if (!r.ok) return { ok: false, error: r.error, code: 'startFailed' };

      return {
        ok: true,
        value: null,
        events: [
          { type: 'GAME_STARTED', payload: { round: state.round, playerCount: state.order.length } },
          { type: 'ROUND_UPDATED', payload: { round: state.round, phase: state.phase } },
        ],
      };
    });

    if (!outcome.ok) {
      const status = outcome.code === 'noRoom' ? 404 : outcome.code === 'forbidden' ? 403 : 400;
      return apiError(outcome.error, outcome.code, status);
    }

    console.log(`[room] 開始 ${outcome.state.code} 参加者${outcome.state.order.length}人`);

    return json({ state: snapshot(outcome.state, outcome.rules, { role: 'teacher' }) });
  } catch (err) {
    return handleUnexpected(err);
  }
}
