/**
 * Supabase クライアント。
 *
 * 2種類あります。役割を混ぜないでください。
 *
 *   supabaseAdmin()   … service_role キー。**サーバ（Vercel Functions）専用**。
 *                       RLS をバイパスしてゲーム状態を読み書きします。
 *   supabaseBrowser() … anon キー。ブラウザで Realtime を購読するためだけに使います。
 *                       RLS によりテーブルには一切アクセスできません（schema.sql 参照）。
 *
 * ★ 移行メモ: 旧 server/store.js の data/rooms.json（ローカルファイル）の置き換えです。
 *    Vercel はデプロイ後のファイル書き込みができず、インスタンスも使い捨てなので、
 *    永続化は必ず外部（ここでは Supabase Postgres）に置く必要があります。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** 環境変数が未設定なら、原因がすぐ分かるメッセージで落とす */
function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。` +
        ' .env.local（ローカル）または Vercel の Environment Variables を確認してください。'
    );
  }
  return value;
}

/* ------------------------------------------------------------------ サーバ側 */

let adminClient: SupabaseClient | null = null;

/**
 * service_role クライアント（サーバ専用）。
 * これをクライアントコンポーネントから import しないこと。
 */
export function supabaseAdmin(): SupabaseClient {
  if (adminClient) return adminClient;
  adminClient = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', url),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      // サーバレスでは WebSocket を張らない。broadcast は下の HTTP API を使う。
      realtime: { params: { eventsPerSecond: 0 } },
    }
  );
  return adminClient;
}

/* ------------------------------------------------------------------ ブラウザ側 */

let browserClient: SupabaseClient | null = null;

/** anon クライアント（ブラウザ専用 / Realtime 購読のみ） */
export function supabaseBrowser(): SupabaseClient {
  if (browserClient) return browserClient;
  browserClient = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL', url),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 20 } },
    }
  );
  return browserClient;
}

/* ------------------------------------------------------------------ broadcast */

/**
 * サーバから Realtime チャンネルへ送る。
 *
 * サーバレス関数で WebSocket を張ると、接続確立だけで数百ミリ秒かかり、
 * 関数終了時に切断されてしまいます。そのため Supabase Realtime の
 * HTTP broadcast エンドポイントを 1回の fetch で叩きます。
 */
export async function broadcast(
  topic: string,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const base = requireEnv('NEXT_PUBLIC_SUPABASE_URL', url);
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const res = await fetch(`${base}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload }] }),
    });
    if (!res.ok) {
      console.warn('[realtime] broadcast 失敗:', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    // 配信に失敗しても、ゲームの状態はすでにDBに保存済みです。
    // 画面側は再取得（ポーリング）でも追いつけるため、ここでは落としません。
    console.warn('[realtime] broadcast エラー:', (err as Error).message);
  }
}
