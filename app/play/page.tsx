/**
 * 生徒用画面（旧 public/play.html）
 *
 * QRコードや先生が配ったURLの ?code=123456 は、
 * 既存の play.js が location.search から読み取ります（旧実装と同じ）。
 */

import type { Metadata } from 'next';
import '@/styles/app.css';
import PlayClient from './PlayClient';

export const metadata: Metadata = {
  title: 'フェアトレード・チャレンジ｜生徒用',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍫</text></svg>",
  },
};

export default function Page() {
  return <PlayClient />;
}
