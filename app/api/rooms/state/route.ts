/**
 * GET /api/rooms/state?code=123456&token=xxxx — 自分用のスナップショットを取る
 *
 * 旧: WebSocket が push していた { t:'state' } の置き換えです。
 *
 * Realtime の broadcast は「変わったよ」という合図だけを運びます（lib/realtime.ts 参照）。
 * 各ブラウザは合図を受け取ると、自分のトークンを付けてここへ取りに来ます。
 * こうすることで、生徒が他人の選択を見られないまま、全員が即座に同じ進行を見られます。
 *
 * このルートは基本的に読み取り専用です。
 * ただし制限時間を過ぎていた場合だけ、締め切りを起こしてから返します。
 */

import { json, apiError, handleUnexpected, viewerOf, normalizeCode, str } from '@/lib/api';
import { getRoom, mutateRoom } from '@/lib/store';
import { snapshot } from '@/lib/game';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = normalizeCode(url.searchParams.get('code'));
    const token = str(url.searchParams.get('token'), 64);

    if (!code) return apiError('ルーム番号がありません。', 'badRequest', 400);

    let loaded = await getRoom(code);
    if (!loaded) return apiError('ルームが見つかりません。', 'noRoom', 404);

    // 制限時間が過ぎていたら、ここで締め切る（サーバ側の setTimeout の代わり）。
    // 書き込みが必要なときだけ mutateRoom を通すので、通常のポーリングは読み取りだけで済みます。
    const needsTick =
      loaded.state.phase === 'decision' &&
      !!loaded.state.deadline &&
      Date.now() >= loaded.state.deadline &&
      loaded.state.order.length > 0;

    if (needsTick) {
      const ticked = await mutateRoom(code, () => ({ ok: true, value: null, events: [] }));
      if (ticked.ok) loaded = { row: ticked.row, state: ticked.state, rules: ticked.rules };
    }

    const viewer = viewerOf(loaded.state, token);
    if (!viewer) {
      return apiError('前回の参加情報が確認できませんでした。もう一度参加してください。', 'noSession', 401);
    }
    if (loaded.state.closed) {
      return apiError('このルームは終了しています。', 'roomClosed', 410);
    }

    return json({
      version: loaded.row.version,
      state: snapshot(loaded.state, loaded.rules, viewer),
    });
  } catch (err) {
    return handleUnexpected(err);
  }
}
