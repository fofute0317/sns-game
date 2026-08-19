/**
 * トップページ（旧 public/index.html）
 */

import type { Metadata } from 'next';
import '@/styles/home.css';
import HomeClient from './HomeClient';

export const metadata: Metadata = {
  title: 'チョコレートの旅 ｜ フェアトレード・チャレンジ',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🍫</text></svg>",
  },
};

export default function Page() {
  return <HomeClient />;
}
