/**
 * API ルート用の小さな道具箱。
 *
 * ★ 移行メモ: 旧 server/index.js の sendJson() / handleMessage() の入口部分にあたります。
 *    WebSocket の1本の接続で「誰が話しているか」を覚えていた部分を、
 *    毎リクエストのトークン検証に置き換えています（サーバレスは接続を覚えられないため）。
 */

import { NextResponse } from 'next/server';
import type { RoomState, Viewer } from './types';

/** キャッシュ禁止のJSON応答（授業中に古い状態が返ると事故になる） */
export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export function apiError(message: string, code = 'error', status = 400): NextResponse {
  return json({ error: message, code }, status);
}

/** 本文が壊れていても 500 にせず、空オブジェクトとして扱う */
export async function readBody(req: Request): Promise<Record<string, any>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

/**
 * トークンから「誰か」を判定する。
 *
 * 匿名運用のため、アカウントは作りません。
 *   先生 : ルーム作成時に発行した teacherToken
 *   生徒 : 参加時に発行した player.token
 * どちらもブラウザの sessionStorage / localStorage に保存され、毎回送られてきます。
 */
export function viewerOf(state: RoomState, token: string | null | undefined): Viewer | null {
  if (!token) return null;
  if (token === state.teacherToken) return { role: 'teacher', playerId: null };
  for (const p of Object.values(state.players)) {
    if (p.token === token) return { role: 'player', playerId: p.id };
  }
  return null;
}

/** 文字列の入力を安全に取り出す */
export function str(v: unknown, max = 200): string {
  return String(v ?? '').trim().slice(0, max);
}

/** ルーム番号の正規化（全角数字・記号混じりでも受け付ける） */
export function normalizeCode(v: unknown): string {
  return String(v ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
    .slice(0, 6);
}

/**
 * 予期しない例外を、画面に出せる形にそろえる。
 *
 * 授業の直前に困らないよう、設定ミス・接続不良は原因が分かる文言で返します
 * （ゲームの内部情報は出しません）。
 */
export function handleUnexpected(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api] 予期しないエラー:', err);

  // 環境変数の設定漏れは、原因をそのまま出したほうが早く直せる
  if (message.includes('環境変数')) return apiError(message, 'config', 500);

  // Supabase に届いていない（URLの打ち間違い・プロジェクト停止・ネットワーク遮断）
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo|Invalid API key|JWT/i.test(message)) {
    return apiError(
      'データベースに接続できませんでした。Supabase の URL とキーの設定を確認してください。',
      'dbUnavailable',
      503
    );
  }

  return apiError('サーバ側でエラーが発生しました。', 'internal', 500);
}
