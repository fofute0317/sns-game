/**
 * GET /j/123456 — QRコード用の短いURL
 *
 * 旧: server/index.js の 302 リダイレクト（/j/123456 → /play.html?code=123456）
 * 先生画面が表示するQRコードは、このURLを指しています。
 *
 * Location は**相対パス**で返します。
 * リクエストのURLから絶対URLを組み立てると、Vercel のプロキシを通ったときに
 * 内部ホスト名が入ってしまい、生徒の端末が開けないURLになることがあります。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const digits = String(code || '').replace(/\D/g, '').slice(0, 8);
  const location = digits.length >= 4 ? `/play?code=${digits}` : '/play';

  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}
