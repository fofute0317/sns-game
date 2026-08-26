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
    // ★ head: true（HEADリクエスト）は使わない。
    //   テーブルが無いとき PostgREST は本文なしで返すため、エラーを読み取れず、
    //   error が null のまま「正常」に見えてしまいます。
    //   （実際に、テーブル未作成の状態で ok:true を返す不具合が起きました）
    //   本文が返る通常のリクエストにすることで、原因まで受け取れます。
    const { error, count } = await supabaseAdmin()
      .from('rooms')
      .select('id', { count: 'exact' })
      .neq('status', 'closed')
      .limit(1);

    if (error) throw new Error(error.message);

    return json({
      ok: true,
      rooms: count ?? 0,
      db: 'connected',
      latencyMs: Date.now() - started,
      node: process.version,
    });
  } catch (err) {
    const message = (err as Error).message;
    const missingTable = /schema cache|does not exist|relation .* does not exist/i.test(message);
    return json(
      {
        ok: false,
        db: 'error',
        message,
        hint: missingTable
          ? 'テーブルがまだありません。Supabase の SQL Editor で supabase/schema.sql を実行してください。'
          : undefined,
        latencyMs: Date.now() - started,
      },
      503
    );
  }
}
