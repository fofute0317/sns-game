/**
 * マークアップの移行テスト。
 *
 * 旧 public/*.html の <body> を client/markup/*.ts へ移しました（VanillaPage が挿入します）。
 * 既存の画面ロジックは getElementById / querySelector で要素を探して描画するため、
 * id が1つでも欠けると、その場所だけ黙って描画されなくなります。
 * ここでは、移行前の HTML にあった id と、画面が必要とする構造がすべて残っているかを確かめます。
 *
 * 下の一覧は、移行前の public/index.html・teacher.html・play.html から機械的に抜き出したものです。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { HOME_MARKUP, HOME_MARKUP_BODY_CLASS } = await import('../.test-build/client/markup/home.js');
const { TEACHER_MARKUP, TEACHER_MARKUP_BODY_CLASS } = await import('../.test-build/client/markup/teacher.js');
const { PLAY_MARKUP, PLAY_MARKUP_BODY_CLASS } = await import('../.test-build/client/markup/play.js');

/** 移行前の HTML にあった id（1つでも欠けたら画面が壊れる） */
const EXPECTED_IDS = {
  home: 'dlgHowto dlgNews ground menuCard menuClose menuHero menuTitle menuVeil newsList sea sky startHint startLayer sunGlow',
  teacher:
    'addBotBtn adminBar adminCode adminRule backBtn chipPlayers chipRoom chipRound closeRoomBtn conn createBtn ' +
    'demandMode exportBtn finalBody finalHint flowHelp forceBtn joinUrl lobbyCount lobbyPlayers maxPlayers ' +
    'nextBtn nextBtn2 printBtn projBtn qrBox restartBtn roomCode rulesetNote rulesetSel runBody runEvent ' +
    'runHead runStatusText startBtn startHint teacherResumeBox teacherResumeBtn timerSec',
  play:
    'chipCompany chipRoom chipRound codeInput conn decEvent decGroups decHistory decMargin decStatus decSubmit ' +
    'decTitle finalBody howto joinBtn joinError joinForm lobbyCode lobbyCount lobbyMembers lobbyPlayers lobbyWait ' +
    'myCard nameInput resAll resHead resLearn resMine resTitle resWait resumeBox resumeBtn roomSettings rosterList',
};

const idsIn = (markup) => new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

for (const [page, expected] of Object.entries(EXPECTED_IDS)) {
  const markup = { home: HOME_MARKUP, teacher: TEACHER_MARKUP, play: PLAY_MARKUP }[page];

  test(`${page}: 移行前の id がすべて残っている`, () => {
    const found = idsIn(markup);
    const missing = expected.split(' ').filter((id) => !found.has(id));
    assert.deepEqual(missing, [], `欠けている id: ${missing.join(', ')}`);
  });

  test(`${page}: id が重複していない`, () => {
    const all = [...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    assert.deepEqual(dupes, [], `重複している id: ${dupes.join(', ')}`);
  });
}

/* ------------------------------------------------ 画面切替の土台 */

test('先生用・生徒用に .screen[data-screen] がそろっている', () => {
  const screensOf = (m) => [...m.matchAll(/data-screen="([^"]+)"/g)].map((x) => x[1]).sort();

  // ui.js の showScreen() が data-screen を見て切り替える
  assert.deepEqual(screensOf(TEACHER_MARKUP), ['final', 'lobby', 'running', 'setup']);
  assert.deepEqual(screensOf(PLAY_MARKUP), ['decision', 'final', 'join', 'lobby', 'result']);
});

test('body のクラスが移行前と同じ', () => {
  assert.equal(HOME_MARKUP_BODY_CLASS, 'home');
  assert.equal(TEACHER_MARKUP_BODY_CLASS, 'screen-setup');
  assert.equal(PLAY_MARKUP_BODY_CLASS, 'screen-join');
});

/* ------------------------------------------------ 移行で意図的に変えた箇所 */

test('旧サーバのパス（.html）が残っていない', () => {
  for (const [page, markup] of Object.entries({ home: HOME_MARKUP, teacher: TEACHER_MARKUP, play: PLAY_MARKUP })) {
    assert.equal(/href="[^"]*\.html/.test(markup), false, `${page} に .html へのリンクが残っている`);
  }
});

test('トップページから先生用・生徒用へ行ける', () => {
  assert.ok(HOME_MARKUP.includes('href="/teacher"'), '先生用への導線');
  assert.ok(HOME_MARKUP.includes('href="/play"'), '生徒用への導線');
});

test('マークアップに <script> が混ざっていない（Next 側で読み込むため）', () => {
  for (const [page, markup] of Object.entries({ home: HOME_MARKUP, teacher: TEACHER_MARKUP, play: PLAY_MARKUP })) {
    assert.equal(markup.includes('<script'), false, `${page} に script タグが残っている`);
  }
});
