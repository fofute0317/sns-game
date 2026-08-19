/**
 * POST /api/game/update — ゲーム状態を進める・変える操作をまとめて受ける
 *
 * 旧: WebSocket メッセージ { t: 'draft' | 'unsubmit' | 'leave' | 'next' | ... }
 *
 * リクエスト  { code, token, action, ...パラメータ }
 * レスポンス  { state }  ← 送り主用のスナップショット
 *
 * ひとつのルートに集約している理由:
 *   どの操作も「ルームを1行ロックして、状態を1回書き換える」という同じ形だからです。
 *   分けると同じ楽観ロックの手続きを何度も書くことになり、
 *   片方だけ直し忘れるといった事故が起きます。
 *
 * 生徒ができる操作 : draft / unsubmit / leave
 * 先生だけの操作   : forceResolve / next / back / restart / addBot /
 *                    removePlayer / setOptions / closeRoom
 */

import { readBody, json, apiError, handleUnexpected, viewerOf, normalizeCode, str } from '@/lib/api';
import { mutateRoom } from '@/lib/store';
import {
  setDraft,
  unsubmit,
  removePlayer,
  forceResolve,
  next,
  back,
  restart,
  addPlayer,
  setOptions,
  closeRoom,
  snapshot,
  PHASE,
} from '@/lib/game';
import { companies } from '@/lib/rules';
import { STRATEGY_IDS, BOT_ROTATION } from '@/lib/bots';
import type { EmitEvent } from '@/lib/store';
import type { Viewer } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLAYER_ACTIONS = new Set(['draft', 'unsubmit', 'leave']);

export async function POST(req: Request) {
  try {
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    const token = str(body.token, 64);
    const action = str(body.action, 32);

    const outcome = await mutateRoom<{ viewer: Viewer; left: boolean }>(code, ({ state, rules }) => {
      const viewer = viewerOf(state, token);
      if (!viewer) return { ok: false, error: 'ルームに接続していません。', code: 'notInRoom' };

      const events: EmitEvent[] = [];
      const isTeacher = viewer.role === 'teacher';

      /* -------------------------------------------------- 生徒の操作 */

      if (PLAYER_ACTIONS.has(action)) {
        if (!viewer.playerId) return { ok: false, error: 'この操作はできません。', code: 'forbidden' };
        const playerId = viewer.playerId;

        if (action === 'draft') {
          setDraft(state, rules, playerId, body.decision || {});
          // 下書きは自分の画面にしか関係しないので、他の人へは流さない。
          // events を空にすると配信されません（lib/store.ts の fanout 参照）。
          return { ok: true, value: { viewer, left: false }, events: [] };
        }
        if (action === 'unsubmit') {
          unsubmit(state, playerId);
          return {
            ok: true,
            value: { viewer, left: false },
            events: [{ type: 'ANSWER_SUBMITTED', payload: { playerId, submitted: false } }],
          };
        }

        // leave — 抜けた結果、残り全員が提出ずみになってラウンドが解決することがある
        const phaseBefore = state.phase;
        removePlayer(state, rules, playerId);
        events.push({ type: 'PLAYER_LEFT', payload: { playerId, playerCount: state.order.length } });
        if (phaseBefore === PHASE.DECISION && state.phase === PHASE.RESULT) {
          events.push({ type: 'ROUND_UPDATED', payload: { round: state.round, closedBy: 'all' } });
          events.push({ type: 'SCORE_UPDATED', payload: { round: state.round } });
        }
        return { ok: true, value: { viewer, left: true }, events };
      }

      /* -------------------------------------------------- ここから先生専用 */

      if (!isTeacher) return { ok: false, error: '権限がありません。', code: 'forbidden' };

      switch (action) {
        case 'forceResolve': {
          const r = forceResolve(state, rules, 'teacher');
          if (!r.ok) return { ok: false, error: r.error, code: 'resolveFailed' };
          events.push({ type: 'ROUND_UPDATED', payload: { round: state.round, closedBy: 'teacher' } });
          events.push({ type: 'SCORE_UPDATED', payload: { round: state.round } });
          break;
        }

        case 'next': {
          const r = next(state, rules);
          if (!r.ok) return { ok: false, error: r.error, code: 'nextFailed' };
          events.push(
            state.phase === PHASE.FINAL
              ? { type: 'GAME_FINISHED', payload: { finalStage: state.finalStageIndex } }
              : { type: 'ROUND_UPDATED', payload: { round: state.round, phase: state.phase } }
          );
          break;
        }

        case 'back': {
          const r = back(state);
          if (!r.ok) return { ok: false, error: r.error, code: 'backFailed' };
          events.push({ type: 'GAME_FINISHED', payload: { finalStage: state.finalStageIndex } });
          break;
        }

        case 'restart': {
          restart(state, rules);
          events.push({ type: 'ROUND_UPDATED', payload: { restarted: true } });
          break;
        }

        case 'addBot': {
          // 指定がなければ、毎回同じ顔ぶれにならないよう順番に選ぶ
          const botCount = state.order.filter((id) => state.players[id]?.isBot).length;
          const strategy = STRATEGY_IDS.includes(str(body.strategy, 20))
            ? str(body.strategy, 20)
            : BOT_ROTATION[botCount % BOT_ROTATION.length];
          const nameList = companies.botNames || ['AI'];
          const added = addPlayer(state, rules, companies, {
            name: nameList[botCount % nameList.length],
            isBot: true,
            botStrategy: strategy,
          });
          if (!added.ok) return { ok: false, error: added.error, code: 'cannotJoin' };
          events.push({
            type: 'PLAYER_JOINED',
            payload: { playerId: added.player.id, nickname: added.player.name, isBot: true },
          });
          break;
        }

        case 'removePlayer': {
          const target = str(body.playerId, 40);
          if (!state.players[target]) {
            return { ok: false, error: 'その参加者は見つかりません。', code: 'noPlayer' };
          }
          removePlayer(state, rules, target);
          events.push({
            type: 'PLAYER_KICKED',
            payload: { playerId: target, message: '先生によって退出しました。' },
          });
          break;
        }

        case 'setOptions': {
          setOptions(state, { timerSec: body.timerSec, autoAdvance: body.autoAdvance });
          // 生徒の画面にも制限時間が出るので、全員に知らせる
          events.push({ type: 'STATE_CHANGED', payload: { timerSec: state.options.timerSec } });
          break;
        }

        case 'closeRoom': {
          closeRoom(state);
          events.push({
            type: 'ROOM_CLOSED',
            payload: { message: 'ゲームが終了しました。ご参加ありがとうございました！' },
          });
          break;
        }

        default:
          return { ok: false, error: `不明な操作です: ${action}`, code: 'badRequest' };
      }

      return { ok: true, value: { viewer, left: false }, events };
    });

    if (!outcome.ok) {
      const status = outcome.code === 'noRoom' ? 404 : outcome.code === 'forbidden' ? 403 : 400;
      return apiError(outcome.error, outcome.code, status);
    }

    if (action === 'closeRoom') console.log(`[room] 終了 ${outcome.state.code}`);

    // 退出した本人には、もう見せる状態がない
    if (outcome.value.left) return json({ left: true });

    return json({ state: snapshot(outcome.state, outcome.rules, outcome.value.viewer) });
  } catch (err) {
    return handleUnexpected(err);
  }
}
