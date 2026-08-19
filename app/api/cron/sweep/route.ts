/**
 * GET /api/cron/sweep — 使われなくなったルームの後片付け
 *
 * 旧: setInterval(() => store.sweep(), 10分)（server/index.js）
 * 新: Vercel Cron が毎時ここを叩きます（vercel.json の crons）。
 *
 * 6時間さわられていないルームを削除します。
 * players / game_events は外部キーの ON DELETE CASCADE で一緒に消えます。
 */

import { json, apiError, handleUnexpected } from '@/lib/api';
import { sweepStaleRooms } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    // CRON_SECRET を設定してあれば、外部からの呼び出しを拒否する
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.headers.get('authorization');
      if (auth !== `Bearer ${secret}`) return apiError('権限がありません。', 'forbidden', 401);
    }

    const removed = await sweepStaleRooms();
    return json({ ok: true, removed });
  } catch (err) {
    return handleUnexpected(err);
  }
}
