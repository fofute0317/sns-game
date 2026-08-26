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

/**
 * 環境変数がそろっているかを、値を出さずに報告する。
 *
 * 「どれが抜けているか」が分からないと、Vercel の設定画面で
 * 3つを見比べる作業になります。名前と有無だけを返します（値は絶対に出しません）。
 */
function envReport() {
  const names = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ] as const;

  const present: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const name of names) {
    const ok = !!process.env[name];
    present[name] = ok;
    if (!ok) missing.push(name);
  }
  return { present, missing };
}

export async function GET() {
  const started = Date.now();
  const env = envReport();

  // 環境変数が抜けていると、この先の接続確認は必ず失敗します。
  // 先に「何が抜けているか」を返したほうが早く直せます。
  if (env.missing.length) {
    return json(
      {
        ok: false,
        db: 'unchecked',
        env: env.present,
        message: `環境変数が設定されていません: ${env.missing.join(', ')}`,
        hint: 'ローカルは .env.local、公開先は Vercel の Environment Variables に設定し、Vercel では Redeploy してください（NEXT_PUBLIC_ はビルド時に埋め込まれます）。',
        latencyMs: Date.now() - started,
      },
      503
    );
  }

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
      env: env.present,
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
        env: env.present,
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
