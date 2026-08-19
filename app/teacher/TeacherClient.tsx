'use client';

import VanillaPage from '@/client/VanillaPage';
import { TEACHER_MARKUP, TEACHER_MARKUP_BODY_CLASS } from '@/client/markup/teacher';

export default function TeacherClient() {
  return (
    <VanillaPage
      markup={TEACHER_MARKUP}
      bodyClass={TEACHER_MARKUP_BODY_CLASS}
      boot={() => import('@/client/teacher.js')}
    />
  );
}
