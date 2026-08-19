'use client';

import VanillaPage from '@/client/VanillaPage';
import { PLAY_MARKUP, PLAY_MARKUP_BODY_CLASS } from '@/client/markup/play';

export default function PlayClient() {
  return (
    <VanillaPage
      markup={PLAY_MARKUP}
      bodyClass={PLAY_MARKUP_BODY_CLASS}
      boot={() => import('@/client/play.js')}
    />
  );
}
