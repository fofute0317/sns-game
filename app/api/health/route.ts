/**
 * GET /api/health — 死活確認
 *
 * 旧: GET /api/health（rooms 数・uptime を返していた）
 * サーバレスには uptime が無いので、代わりに DB へ実際につながるかを確かめます。
 * 授業の直前に、ここを開いて「ok: true」を確認するのがおすすめです。
 */

import { json } from '@/lib/api';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const started = Date.now();
  try {
    const { count, error } = await supabaseAdmin()
      .from('rooms')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'closed');

    if (error) throw new Error(error.message);

    return json({
      ok: true,
      rooms: count ?? 0,
      db: 'connected',
      latencyMs: Date.now() - started,
      node: process.version,
    });
  } catch (err) {
    return json(
      { ok: false, db: 'error', message: (err as Error).message, latencyMs: Date.now() - started },
      503
    );
  }
}
