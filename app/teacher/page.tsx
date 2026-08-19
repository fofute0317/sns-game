/**
 * 先生用コンソール（旧 public/teacher.html）
 */

import type { Metadata } from 'next';
import '@/styles/app.css';
import TeacherClient from './TeacherClient';

export const metadata: Metadata = {
  title: 'フェアトレード・チャレンジ｜先生用コンソール',
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎓</text></svg>",
  },
};

export default function Page() {
  return <TeacherClient />;
}
