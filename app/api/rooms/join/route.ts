/**
 * POST /api/rooms/join — 生徒がルーム番号で参加する
 *
 * 旧: WebSocket メッセージ { t: 'joinRoom' }
 *
 * リクエスト  { code: '123456', name: 'たろう' }
 * レスポンス  { role:'player', playerId, token, rules, state }
 *
 * 会社（レッドカカオ社など）は参加順に自動で割り当てられます。
 * 同時に複数人が押しても、楽観ロック（lib/store.ts）で順番に処理されるため
 * 会社が二重に割り当てられることはありません。
 */

import { readBody, json, apiError, handleUnexpected, str, normalizeCode } from '@/lib/api';
import { mutateRoom } from '@/lib/store';
import { addPlayer, canJoin, snapshot, setConnected } from '@/lib/game';
import { companies } from '@/lib/rules';
import type { RoomPlayer } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    const name = str(body.name, 24);

    if (code.length < 4) {
      return apiError('ルーム番号を入力してください（数字6けた）。', 'badRequest', 400);
    }

    const outcome = await mutateRoom<RoomPlayer>(code, ({ state, rules }) => {
      const check = canJoin(state);
      if (!check.ok) return { ok: false, error: check.message as string, code: 'cannotJoin' };

      const added = addPlayer(state, rules, companies, { name });
      if (!added.ok) return { ok: false, error: added.error, code: 'cannotJoin' };

      setConnected(state, added.player.id, true);

      return {
        ok: true,
        value: added.player,
        events: [
          {
            type: 'PLAYER_JOINED',
            payload: {
              playerId: added.player.id,
              nickname: added.player.name,
              company: added.player.company,
              playerCount: state.order.length,
            },
          },
        ],
      };
    });

    if (!outcome.ok) {
      return apiError(outcome.error, outcome.code, outcome.code === 'noRoom' ? 404 : 400);
    }

    const player = outcome.value;
    return json({
      role: 'player',
      playerId: player.id,
      token: player.token,
      roomCode: outcome.state.code,
      rules: outcome.rules,
      state: snapshot(outcome.state, outcome.rules, { role: 'player', playerId: player.id }),
    });
  } catch (err) {
    return handleUnexpected(err);
  }
}
