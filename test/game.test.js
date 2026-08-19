/**
 * 移行後のゲーム進行テスト。
 *
 * 旧 test/e2e.test.js は、本物の WebSocket サーバを立ち上げて確認していました。
 * サーバレス化でその「立ち上げっぱなしのサーバ」が無くなったため、
 * 同じ検証項目を、状態遷移そのもの（lib/game.ts）に対して行います。
 *
 * 確認したいこと（発注時の「MVPで検証したいこと」と同じ）:
 *   ① 4〜6人が同じルームに入れる
 *   ② 先生がゲームを開始できる
 *   ③ 全員が同じゲーム状態を共有できる
 *   ④ 各プレイヤーが意思決定できる
 *   ⑥ ラウンドごとの結果が同期される
 *   ⑦ 最終的にランキングが表示される
 *   ＋ 再接続（トークンでの復帰）
 *   ＋ 移行で新しく必要になった点（サーバ側タイマーの廃止・AIの即時確定・秘密の保持）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { loadRuleset, companies } = await import('../.test-build/lib/rules.js');
const game = await import('../.test-build/lib/game.js');
const { viewerOf } = await import('../.test-build/lib/api.js');
const { resolveRound } = await import('../.test-build/lib/engine.js');
const { decideForBot } = await import('../.test-build/lib/bots.js');
const { rngFor } = await import('../.test-build/lib/rng.js');

const PLAY = { cacao: 'fairtrade', sugar: 'direct', price: 'mid', ad: 'small', give: 'mid' };

function newRoom({ ruleId = 'mvp', options = {}, seed = 'test-seed' } = {}) {
  const baseRules = loadRuleset(ruleId);
  const state = game.createRoomState({ code: '123456', rules: baseRules, options, seed });
  return { state, rules: game.rulesFor(baseRules, state) };
}

function join(state, rules, name, extra = {}) {
  const r = game.addPlayer(state, rules, companies, { name, ...extra });
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.player;
}

/* ================================================================== 参加 */

test('① 6人が同じルームに入れる（会社は重複せず、全員に割り当てられる）', () => {
  const { state, rules } = newRoom({ options: { maxPlayers: 6 } });
  const players = ['あおい', 'はると', 'ゆい', 'そうた', 'めい', 'りく'].map((n) => join(state, rules, n));

  assert.equal(game.playerCount(state), 6);
  assert.equal(new Set(players.map((p) => p.company)).size, 6, '会社が重複していない');
  assert.equal(new Set(players.map((p) => p.token)).size, 6, 'トークンが重複していない');
  assert.equal(new Set(players.map((p) => p.id)).size, 6, 'IDが重複していない');
});

test('定員に達したら参加できない', () => {
  const { state, rules } = newRoom({ options: { maxPlayers: 2 } });
  join(state, rules, 'A');
  join(state, rules, 'B');

  const third = game.addPlayer(state, rules, companies, { name: 'C' });
  assert.equal(third.ok, false);
  assert.match(third.error, /定員/);
});

test('同じ名前の生徒には (2) が付く', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'たろう');
  const b = join(state, rules, 'たろう');
  assert.equal(a.name, 'たろう');
  assert.equal(b.name, 'たろう(2)');
});

test('ゲーム開始後は参加できない', () => {
  const { state, rules } = newRoom();
  join(state, rules, 'A');
  join(state, rules, 'B');
  game.start(state, rules);

  const late = game.addPlayer(state, rules, companies, { name: '遅刻' });
  assert.equal(late.ok, false);
  assert.match(late.error, /始まっている/);
});

/* ================================================================== 開始・進行 */

test('② 人数が足りないと開始できない / 足りれば開始できる', () => {
  const { state, rules } = newRoom();
  assert.equal(game.start(state, rules).ok, false, '0人では開始できない');

  join(state, rules, 'A');
  join(state, rules, 'B');

  const started = game.start(state, rules);
  assert.equal(started.ok, true);
  assert.equal(state.phase, 'decision');
  assert.equal(state.round, 1);
  assert.equal(state.eventPlan.length, rules.game.rounds, 'イベントは開始前に全ラウンド分決まっている');
});

test('④⑥ 全員が提出するとラウンドが解決され、資金が動く', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  const b = join(state, rules, 'B');
  game.start(state, rules);

  const before = state.players[a.id].score.funds;

  game.submit(state, rules, a.id, PLAY);
  assert.equal(state.phase, 'decision', '1人だけではまだ締め切られない');

  game.submit(state, rules, b.id, PLAY);
  assert.equal(state.phase, 'result', '全員そろったら自動で締め切られる');
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].closedBy, 'all');
  assert.notEqual(state.players[a.id].score.funds, before, '資金が計算されている');
  assert.equal(state.rounds[0].results.length, 2);
});

test('選び直し（unsubmit）ができ、締め切りは取り消される', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  const b = join(state, rules, 'B');
  game.start(state, rules);

  game.submit(state, rules, a.id, PLAY);
  assert.equal(state.players[a.id].submitted, true);

  game.unsubmit(state, a.id);
  assert.equal(state.players[a.id].submitted, false);

  // 提出済みのあとに選び直すと、提出が取り消される
  game.submit(state, rules, a.id, PLAY);
  game.setDraft(state, rules, a.id, { price: 'high' });
  assert.equal(state.players[a.id].submitted, false, '選び直したら提出は取り消し扱い');
  assert.equal(state.players[a.id].draft.price, 'high');

  game.submit(state, rules, a.id);
  game.submit(state, rules, b.id, PLAY);
  assert.equal(state.phase, 'result');
});

test('先生が待たずに締め切れる（未提出者は、そのときの選択で計算される）', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  join(state, rules, 'B');
  game.start(state, rules);
  game.submit(state, rules, a.id, PLAY);

  const r = game.forceResolve(state, rules, 'teacher');
  assert.equal(r.ok, true);
  assert.equal(state.phase, 'result');
  assert.equal(state.rounds[0].closedBy, 'teacher');
  assert.equal(state.rounds[0].results.filter((x) => x.auto).length, 1, '未提出の1人は自動扱い');
});

test('⑦ 5ラウンド進めると最終画面に入り、ランキングが出る', () => {
  const { state, rules } = newRoom();
  const ids = ['A', 'B', 'C', 'D'].map((n) => join(state, rules, n).id);
  game.start(state, rules);

  for (let r = 1; r <= rules.game.rounds; r++) {
    assert.equal(state.phase, 'decision', `${r}ラウンド目は決定フェーズ`);
    ids.forEach((id) => game.submit(state, rules, id, PLAY));
    assert.equal(state.phase, 'result');
    game.next(state, rules);
  }

  assert.equal(state.phase, 'final');
  assert.equal(state.rounds.length, rules.game.rounds);

  const snap = game.snapshot(state, rules, { role: 'teacher' });
  assert.ok(snap.standings, 'ランキングが計算されている');
  assert.equal(snap.standings.total.length, 4);
  assert.equal(snap.standings.total[0].rank, 1);
  assert.ok(snap.insights.length > 0, 'ふりかえりの気づきが出ている');

  // 最終画面の3段階（利益 → 総合 → ふりかえり）
  assert.equal(snap.finalStage, 'profit');
  game.next(state, rules);
  assert.equal(game.snapshot(state, rules, { role: 'teacher' }).finalStage, 'total');
  game.next(state, rules);
  assert.equal(game.snapshot(state, rules, { role: 'teacher' }).finalStage, 'reflect');
  assert.equal(game.next(state, rules).ok, false, 'これ以上は進めない');
  game.back(state);
  assert.equal(game.snapshot(state, rules, { role: 'teacher' }).finalStage, 'total');
});

test('もう一度あそぶ（restart）で点数がリセットされ、メンバーは残る', () => {
  const { state, rules } = newRoom();
  const ids = ['A', 'B'].map((n) => join(state, rules, n).id);
  game.start(state, rules);
  ids.forEach((id) => game.submit(state, rules, id, PLAY));

  game.restart(state, rules);
  assert.equal(state.phase, 'lobby');
  assert.equal(state.round, 0);
  assert.equal(state.rounds.length, 0);
  assert.equal(game.playerCount(state), 2, 'メンバーは残る');
  assert.equal(state.players[ids[0]].score.funds, rules.game.startingFunds, '資金が初期値に戻る');
});

/* ================================================================== 状態の共有と秘密 */

test('③ 全員が同じ進行を見る。ただし他人の選択は見えない', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  const b = join(state, rules, 'B');
  game.start(state, rules);

  game.setDraft(state, rules, a.id, { price: 'high' });
  game.setDraft(state, rules, b.id, { price: 'low' });

  const snapA = game.snapshot(state, rules, { role: 'player', playerId: a.id });
  const snapB = game.snapshot(state, rules, { role: 'player', playerId: b.id });

  // 同じ進行を見ている
  assert.equal(snapA.round, snapB.round);
  assert.equal(snapA.phase, snapB.phase);
  assert.equal(snapA.playerCount, snapB.playerCount);

  // 自分の選択だけが入っている
  assert.equal(snapA.you.draft.price, 'high');
  assert.equal(snapB.you.draft.price, 'low');

  // 他人の選択はどこにも載っていない
  const serialized = JSON.stringify(snapA.players);
  assert.equal(serialized.includes('draft'), false, '他人の draft が含まれていない');
  assert.equal(
    JSON.stringify(snapA).includes(b.token),
    false,
    '他人のトークンが含まれていない'
  );
});

test('先生用スナップショットには you が入らない', () => {
  const { state, rules } = newRoom();
  join(state, rules, 'A');
  const snap = game.snapshot(state, rules, { role: 'teacher' });
  assert.equal(snap.you, undefined);
  assert.equal(snap.playerCount, 1);
});

/* ================================================================== 認証（トークン） */

test('＋ トークンで「誰か」を判定できる（再接続の土台）', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');

  assert.deepEqual(viewerOf(state, state.teacherToken), { role: 'teacher', playerId: null });
  assert.deepEqual(viewerOf(state, a.token), { role: 'player', playerId: a.id });
  assert.equal(viewerOf(state, 'にせもの'), null);
  assert.equal(viewerOf(state, null), null);
});

test('＋ 再接続: トークンから元の会社に戻れる', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  game.setConnected(state, a.id, false); // 回線が切れた

  const found = game.findByToken(state, a.token);
  assert.equal(found.id, a.id);
  assert.equal(found.company, a.company, '同じ会社に戻る');

  game.setConnected(state, a.id, true);
  assert.equal(state.players[a.id].connected, true);
});

test('先生が生徒を退出させられる', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  join(state, rules, 'B');

  game.removePlayer(state, rules, a.id);
  assert.equal(game.playerCount(state), 1);
  assert.equal(state.players[a.id], undefined);
  assert.equal(game.findByToken(state, a.token), null, '退出後はトークンも無効');
});

/* ================================================================== 移行で変わった部分 */

test('★ 制限時間: サーバ側タイマーの代わりに deadline で締め切られる', () => {
  const { state, rules } = newRoom({ options: { timerSec: 60 } });
  const a = join(state, rules, 'A');
  join(state, rules, 'B');
  game.start(state, rules);

  assert.ok(state.deadline, '開始時に締め切り時刻が入る');
  assert.equal(game.tickDeadline(state, rules), false, 'まだ時間内なので何も起きない');
  assert.equal(state.phase, 'decision');

  game.submit(state, rules, a.id, PLAY);

  // 時間が過ぎた状態を作る
  state.deadline = Date.now() - 1;
  assert.equal(game.tickDeadline(state, rules), true, '時間切れで締め切られる');
  assert.equal(state.phase, 'result');
  assert.equal(state.rounds[0].closedBy, 'time');
  assert.equal(state.deadline, null);
});

test('★ 制限時間なしのルームでは deadline を持たない', () => {
  const { state, rules } = newRoom({ options: { timerSec: 0 } });
  join(state, rules, 'A');
  join(state, rules, 'B');
  game.start(state, rules);
  assert.equal(state.deadline, null);
  assert.equal(game.tickDeadline(state, rules), false);
});

test('★ 練習用AI: 決定フェーズに入った時点で提出済みになる', () => {
  const { state, rules } = newRoom();
  const human = join(state, rules, '人間');
  const bot = game.addPlayer(state, rules, companies, {
    name: 'AIオリバー',
    isBot: true,
    botStrategy: 'balanced',
  }).player;

  game.start(state, rules);

  assert.equal(state.players[bot.id].submitted, true, 'AIはすでに決めている');
  assert.ok(state.players[bot.id].submittedDecision, 'AIの選択が入っている');
  assert.equal(state.players[human.id].submitted, false, '人間はまだ');
  assert.equal(state.phase, 'decision', 'AIだけでは締め切られない');

  game.submit(state, rules, human.id, PLAY);
  assert.equal(state.phase, 'result', '人間が出したら締め切られる');
});

test('★ 決定性: 同じ入力なら計算結果は必ず一致する（提出順にも依存しない）', () => {
  const rules = loadRuleset('mvp');
  const submissions = [
    { playerId: 'p1_aaa', decision: PLAY },
    { playerId: 'p2_bbb', decision: { ...PLAY, price: 'high' } },
    { playerId: 'p3_ccc', decision: { ...PLAY, cacao: 'market' } },
  ];
  const args = { rules, roundIndex: 0, eventId: 'quiet', seed: 'determinism-check' };

  const first = resolveRound({ ...args, submissions });
  const again = resolveRound({ ...args, submissions });
  assert.deepEqual(again, first, '2回計算しても同じ');

  // 提出が届く順番が変わっても結果は変わらない（サーバレスでは到着順が毎回ちがう）
  const shuffled = resolveRound({ ...args, submissions: [...submissions].reverse() });
  assert.deepEqual(shuffled, first, '提出順に依存しない');

  // シードが変われば「運」の部分は変わる
  const other = resolveRound({ ...args, submissions, seed: 'another-seed' });
  assert.notDeepEqual(other, first);
});

test('★ 決定性: AIの手はシード・ラウンド・プレイヤーIDから一意に決まる', () => {
  const rules = loadRuleset('mvp');
  const pickFor = () =>
    decideForBot({
      rules,
      roundIndex: 0,
      eventId: 'quiet',
      strategy: 'balanced',
      rng: rngFor('room-seed', 'bot', 1, 'p1_aaa'),
    });

  assert.deepEqual(pickFor(), pickFor(), '同じ条件なら同じ手を選ぶ');

  const otherPlayer = decideForBot({
    rules,
    roundIndex: 0,
    eventId: 'quiet',
    strategy: 'profit',
    rng: rngFor('room-seed', 'bot', 1, 'p2_bbb'),
  });
  assert.ok(otherPlayer, '別のAIも手を選べる');
});

test('★ 不正な選択肢はサーバ側で既定値に落とされる（例外を投げない）', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  join(state, rules, 'B');
  game.start(state, rules);

  assert.doesNotThrow(() => {
    game.setDraft(state, rules, a.id, { price: '<script>alert(1)</script>', cacao: null, nope: 'x' });
  });
  const draft = state.players[a.id].draft;
  assert.ok(rules.decisions.find((d) => d.key === 'price').options.some((o) => o.id === draft.price));
  assert.equal(draft.nope, undefined, '知らないキーは捨てられる');
});

test('★ ブラウザから金額や点数を送りつけても無視される', () => {
  const { state, rules } = newRoom();
  const a = join(state, rules, 'A');
  join(state, rules, 'B');
  game.start(state, rules);

  // 「利益1兆円」を主張してみる
  game.submit(state, rules, a.id, { ...PLAY, profit: 1e12, funds: 1e12, score: 999 });

  assert.equal(state.players[a.id].score.funds, rules.game.startingFunds, '資金は変わらない');
  assert.equal(state.players[a.id].draft.profit, undefined, '決定に紛れ込まない');
});

test('★ ルームを閉じると参加できなくなる', () => {
  const { state, rules } = newRoom();
  join(state, rules, 'A');
  game.closeRoom(state);

  assert.equal(state.closed, true);
  assert.equal(game.canJoin(state).ok, false);
  assert.match(game.canJoin(state).message, /終了/);
});

test('★ 状態はそのまま JSON にでき、往復しても壊れない（DBに入れるため）', () => {
  const { state, rules } = newRoom();
  const ids = ['A', 'B'].map((n) => join(state, rules, n).id);
  game.start(state, rules);
  ids.forEach((id) => game.submit(state, rules, id, PLAY));

  const roundTripped = JSON.parse(JSON.stringify(state));
  assert.deepEqual(roundTripped, state, 'JSONBに保存して読み戻しても同一');

  // 読み戻した状態から、そのまま続きを進められる
  const r = game.next(roundTripped, rules);
  assert.equal(r.ok, true);
  assert.equal(roundTripped.phase, 'decision');
  assert.equal(roundTripped.round, 2);
});

/* ================================================================== 小学校版 */

test('小学校版（3ラウンド・決めることが少ない）でも通しで遊べる', () => {
  const baseRules = loadRuleset('elementary');
  const state = game.createRoomState({ code: '654321', rules: baseRules, seed: 'el' });
  const rules = game.rulesFor(baseRules, state);

  const ids = ['A', 'B'].map((n) => join(state, rules, n).id);
  game.start(state, rules);

  for (let r = 1; r <= rules.game.rounds; r++) {
    ids.forEach((id) => game.submit(state, rules, id));
    game.next(state, rules);
  }
  assert.equal(state.phase, 'final');
  assert.equal(state.rounds.length, 3);
});
