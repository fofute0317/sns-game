/**
 * ルートレイアウト。
 *
 * 旧 public/*.html の <head> にあたる部分です。
 * <body> のクラス（home / screen-join / screen-setup）は、
 * 画面ごとに client/VanillaPage.tsx が付け替えます（CSS が body.screen-* を見ているため）。
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'フェアトレード・チャレンジ ～チョコレートの旅～',
  description: '中高生向け 複数人対戦型フェアトレード学習ゲーム',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
