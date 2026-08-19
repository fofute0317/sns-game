/**
 * POST /api/rooms/resume — 前回の続きに戻る
 *
 * 旧: WebSocket メッセージ { t: 'resume' }
 *
 * 教室で実際に起きること:
 *   - 生徒がブラウザを更新する / 「戻る」を押す
 *   - Wi-Fi が一瞬切れる、端末がスリープする
 *   - タブを閉じてしまう
 * このどれが起きても、保存されたトークンで同じ会社に戻れるようにします。
 */

import { readBody, json, apiError, handleUnexpected, str, normalizeCode } from '@/lib/api';
import { mutateRoom } from '@/lib/store';
import { findByToken, setConnected, snapshot } from '@/lib/game';
import { STRATEGIES, STRATEGY_IDS } from '@/lib/bots';
import type { Viewer } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    const token = str(body.token, 64);

    if (!code || !token) {
      return apiError('前回の参加情報が確認できませんでした。もう一度参加してください。', 'noSession', 401);
    }

    const outcome = await mutateRoom<Viewer>(code, ({ state }) => {
      if (state.closed) {
        return { ok: false, error: 'このルームは終了しています。', code: 'roomClosed' };
      }

      if (token === state.teacherToken) {
        state.teacherConnected = true;
        // 生徒の画面は teacherConnected を見ているので、全員に知らせる
        return {
          ok: true,
          value: { role: 'teacher', playerId: null },
          events: [{ type: 'STATE_CHANGED', payload: { teacherConnected: true } }],
        };
      }

      const player = findByToken(state, token);
      if (!player) {
        return {
          ok: false,
          error: '前回の参加情報が確認できませんでした。もう一度参加してください。',
          code: 'noSession',
        };
      }
      setConnected(state, player.id, true);
      return {
        ok: true,
        value: { role: 'player', playerId: player.id },
        events: [{ type: 'PLAYER_JOINED', payload: { playerId: player.id, resumed: true } }],
      };
    });

    if (!outcome.ok) {
      const status = outcome.code === 'noRoom' ? 404 : outcome.code === 'noSession' ? 401 : 400;
      return apiError(outcome.error, outcome.code, status);
    }

    const viewer = outcome.value;
    const player = viewer.playerId ? outcome.state.players[viewer.playerId] : null;

    return json({
      role: viewer.role,
      playerId: viewer.playerId,
      token: viewer.role === 'teacher' ? outcome.state.teacherToken : player?.token,
      roomCode: outcome.state.code,
      rules: outcome.rules,
      strategies: STRATEGY_IDS.map((id) => STRATEGIES[id]),
      state: snapshot(outcome.state, outcome.rules, viewer),
    });
  } catch (err) {
    return handleUnexpected(err);
  }
}
