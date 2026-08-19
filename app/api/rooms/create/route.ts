/**
 * POST /api/rooms/create — 先生がルームを作る
 *
 * 旧: WebSocket メッセージ { t: 'createRoom' }
 *
 * リクエスト  { ruleset?: 'mvp' | 'elementary' | 'spec', options?: {...} }
 * レスポンス  { roomCode, roomId, role:'teacher', token, rules, strategies, state }
 *
 * token は先生用の合言葉です。以降の操作はすべてこれで本人確認します
 * （アカウント登録は不要 = 匿名ルームコード方式）。
 */

import { readBody, json, apiError, handleUnexpected, str } from '@/lib/api';
import { createRoom } from '@/lib/store';
import { snapshot } from '@/lib/game';
import { STRATEGIES, STRATEGY_IDS } from '@/lib/bots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const rulesetId = str(body.ruleset, 40) || 'mvp';

    const options = {
      maxPlayers: body.options?.maxPlayers,
      timerSec: body.options?.timerSec,
      demandMode: body.options?.demandMode,
      autoAdvance: body.options?.autoAdvance,
    };

    let created;
    try {
      created = await createRoom({ rulesetId, options });
    } catch (err) {
      return apiError((err as Error).message, 'createFailed', 400);
    }

    const { row, state, rules } = created;
    console.log(`[room] 作成 ${state.code} (${rules.id} / ${state.options.demandMode})`);

    return json({
      roomCode: state.code,
      roomId: row.id,
      role: 'teacher',
      token: state.teacherToken,
      playerId: null,
      rules,
      strategies: STRATEGY_IDS.map((id) => STRATEGIES[id]),
      state: snapshot(state, rules, { role: 'teacher' }),
    });
  } catch (err) {
    return handleUnexpected(err);
  }
}
