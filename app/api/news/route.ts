/**
 * GET /api/news — トップページの「お知らせ」
 *
 * 旧: GET /api/news（毎回 config/news.json を読み直していた）
 *
 * Vercel ではデプロイ後にファイルを書き換えられないため、
 * 「サーバを止めずに更新できる」という旧実装の利点はなくなります。
 * お知らせを変えるときは config/news.json を編集して再デプロイしてください
 * （git push すれば Vercel が自動でデプロイします）。
 */

import { json, handleUnexpected } from '@/lib/api';
import { news } from '@/lib/rules';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return json({ items: news.items || [] });
  } catch (err) {
    return handleUnexpected(err);
  }
}
