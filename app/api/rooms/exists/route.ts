/**
 * GET /api/rooms/exists?code=123456 — ルーム番号が使えるか確かめる
 *
 * 旧: GET /api/room/exists（server/index.js）
 * 生徒の参加画面が、参加前に番号の打ち間違いを知らせるために使います。
 */

import { json, handleUnexpected, normalizeCode } from '@/lib/api';
import { getRoom } from '@/lib/store';
import { canJoin } from '@/lib/game';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const code = normalizeCode(new URL(req.url).searchParams.get('code'));
    if (!code) return json({ exists: false, joinable: false, phase: null });

    const loaded = await getRoom(code);
    if (!loaded) return json({ exists: false, joinable: false, phase: null });

    return json({
      exists: true,
      joinable: canJoin(loaded.state).ok,
      phase: loaded.state.phase,
    });
  } catch (err) {
    return handleUnexpected(err);
  }
}
