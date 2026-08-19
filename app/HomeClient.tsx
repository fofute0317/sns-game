'use client';

import VanillaPage from '@/client/VanillaPage';
import { HOME_MARKUP, HOME_MARKUP_BODY_CLASS } from '@/client/markup/home';

export default function HomeClient() {
  return (
    <VanillaPage
      markup={HOME_MARKUP}
      bodyClass={HOME_MARKUP_BODY_CLASS}
      boot={() => import('@/client/home.js')}
    />
  );
}
