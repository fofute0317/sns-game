/**
 * リサーチ（調べて入力する調達情報）のテスト。
 *
 * 発注者の指定:
 *   ① フェアトレード認証生産者名が明確か      → あれば +10%
 *   ② どれだけの生産者情報を取得したか        → あれば +10%
 *   ③ フェアトレードプレミアムの事業がわかるか → あれば +10%
 *   ④ フェアトレードカカオ豆の値段            → 自分で探す（加点なし）
 *   ⑤ フェアトレード砂糖の値段                → 自分で探す（加点なし）
 *
 * ここでいちばん大事なのは「上位チームの回答が、そのまま実際の仕入れに使われる」ことです。
 * そのため、点数だけでなく **回答そのものが失われずに最後まで運ばれるか** も確認します。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { loadRuleset, companies } = await import('../.test-build/lib/rules.js');
const game = await import('../.test-build/lib/game.js');
const { scoreResearch, emptyResearch, sanitizeResearch, researchFields, computeStandings } = await import(
  '../.test-build/lib/engine.js'
);

const rules = loadRuleset('mvp');

const FULL = {
  producerName: 'Kuapa Kokoo Farmers Union（ガーナ / FLO ID 1234）',
  producerInfo: 'ガーナ。約10万人の小規模農家の組合。カカオ豆を生産。有機認証もあり。',
  premiumUse: '井戸の整備、学校の建設、女性の収入向上プログラム',
  cacaoPrice: '最低価格 US$3,500/t ＋ プレミアム US$275/t（Fairtrade International）',
  sugarPrice: 'FLO認証白砂糖 25kg 13,000円（税別・国内販売価格）',
};

function newRoom() {
  const state = game.createRoomState({ code: '123456', rules, seed: 'research-test' });
  return { state, rules: game.rulesFor(rules, state) };
}

/* ================================================================== 設問定義 */

test('発注者が指定した5項目が、指定どおりの加点設定で定義されている', () => {
  const fields = researchFields(rules);
  assert.deepEqual(
    fields.map((f) => f.key),
    ['producerName', 'producerInfo', 'premiumUse', 'cacaoPrice', 'sugarPrice']
  );
  // ①〜③だけが加点対象
  assert.deepEqual(
    fields.map((f) => f.bonus),
    [true, true, true, false, false]
  );
  // 生徒が調べに行くための入口（FLOCERT）が用意されている
  const links = rules.scoring.research.links || [];
  assert.ok(
    links.some((l) => l.url.includes('flocert.net')),
    'FLOCERT の認証事業者検索へのリンクがない'
  );
});

/* ================================================================== 採点 */

test('加点対象を満たすごとに、総合得点の倍率が10%ずつ増える', () => {
  const none = scoreResearch(rules, emptyResearch());
  assert.equal(none.filledBonusCount, 0);
  assert.equal(none.multiplier, 1);

  const one = scoreResearch(rules, { ...emptyResearch(), producerName: FULL.producerName });
  assert.equal(one.filledBonusCount, 1);
  assert.equal(one.multiplier, 1.1);

  const two = scoreResearch(rules, {
    ...emptyResearch(),
    producerName: FULL.producerName,
    producerInfo: FULL.producerInfo,
  });
  assert.equal(two.multiplier, 1.2);

  const all = scoreResearch(rules, FULL);
  assert.equal(all.filledBonusCount, 3, '加点対象は3項目');
  assert.equal(all.multiplier, 1.3, '最大 +30%');
  assert.equal(all.filledCount, 5, '価格2項目も記入済みとして数える');
});

test('価格（④⑤）は記録されるが、点数には影響しない', () => {
  const priceOnly = scoreResearch(rules, {
    ...emptyResearch(),
    cacaoPrice: FULL.cacaoPrice,
    sugarPrice: FULL.sugarPrice,
  });
  assert.equal(priceOnly.filledBonusCount, 0, '価格だけでは加点されない');
  assert.equal(priceOnly.multiplier, 1);
  assert.equal(priceOnly.filledCount, 2, 'それでも記入済みとして記録される');
});

test('空白だけ・短すぎる入力は「書けた」と認めない', () => {
  const sloppy = scoreResearch(rules, {
    ...emptyResearch(),
    producerName: '   ',
    producerInfo: 'あ',
  });
  assert.equal(sloppy.filledBonusCount, 0);
  assert.equal(sloppy.multiplier, 1);
});

test('入力は安全に整えられる（未知のキーは捨て、長すぎる入力は切り詰める）', () => {
  const dirty = sanitizeResearch({
    producerName: '  Kuapa Kokoo  ',
    nope: 'これは捨てられる',
    producerInfo: 'あ'.repeat(1000),
  });
  assert.equal(dirty.producerName, 'Kuapa Kokoo', '前後の空白は落とす');
  assert.equal(dirty.nope, undefined, '知らないキーは持ち込まない');
  assert.equal(dirty.producerInfo.length, 400, '長すぎる入力は切り詰める');
  assert.equal(dirty.premiumUse, '', '未入力は空文字');
});

/* ================================================================== 保存と反映 */

test('リサーチを保存でき、いつでも書き直せる', () => {
  const { state, rules: r } = newRoom();
  const a = game.addPlayer(state, r, companies, { name: 'あおい' }).player;

  assert.equal(game.setResearch(state, a.id, { producerName: FULL.producerName }).ok, true);
  assert.equal(state.players[a.id].research.producerName, FULL.producerName);

  // 1項目ずつ届いても、前の回答は消えない（部分更新）
  game.setResearch(state, a.id, { premiumUse: FULL.premiumUse });
  assert.equal(state.players[a.id].research.producerName, FULL.producerName);
  assert.equal(state.players[a.id].research.premiumUse, FULL.premiumUse);

  // 書き直せる
  game.setResearch(state, a.id, { producerName: 'べつの組合' });
  assert.equal(state.players[a.id].research.producerName, 'べつの組合');
});

test('自分のスナップショットにリサーチと達成状況が入る', () => {
  const { state, rules: r } = newRoom();
  const a = game.addPlayer(state, r, companies, { name: 'あおい' }).player;
  game.setResearch(state, a.id, FULL);

  const snap = game.snapshot(state, r, { role: 'player', playerId: a.id });
  assert.equal(snap.you.research.producerName, FULL.producerName);
  assert.equal(snap.you.researchScore.filledBonusCount, 3);
  assert.equal(snap.you.researchScore.multiplier, 1.3);
  assert.ok(snap.researchFields.length === 5, '画面がフォームを組み立てられる');
});

test('他人のリサーチの中身は見えない（進捗の数だけ見える）', () => {
  const { state, rules: r } = newRoom();
  const a = game.addPlayer(state, r, companies, { name: 'あおい' }).player;
  const b = game.addPlayer(state, r, companies, { name: 'はると' }).player;
  game.setResearch(state, b.id, FULL);

  const snapA = game.snapshot(state, r, { role: 'player', playerId: a.id });
  const others = snapA.players.filter((p) => p.id === b.id);

  assert.equal(others.length, 1);
  assert.equal(others[0].researchCount, 3, '何項目そろったかは見える（進捗表示）');
  assert.equal(
    JSON.stringify(snapA.players).includes('Kuapa Kokoo'),
    false,
    '他人が調べた中身そのものは見えてはいけない'
  );
});

/* ================================================================== 順位への反映 */

test('経営成績がまったく同じなら、リサーチをした会社が総合で上に立つ', () => {
  // 実際のゲームでは「運」の乱数がプレイヤーごとに違うため、
  // 資金までぴったり同じにはなりません。
  // ここで確かめたいのはリサーチ加点そのものの効果なので、
  // 成績を同一にそろえた状態で computeStandings を直接呼びます。
  const score = { funds: 4200000, producer: 60, society: 35, totalProfit: 1200000 };

  const standings = computeStandings(rules, [
    { id: 'p1', name: 'あおい', company: 'A社', score: { ...score }, research: FULL },
    { id: 'p2', name: 'はると', company: 'B社', score: { ...score }, research: emptyResearch() },
  ]);

  const withResearch = standings.total.find((x) => x.id === 'p1');
  const without = standings.total.find((x) => x.id === 'p2');

  assert.equal(withResearch.researchMultiplier, 1.3);
  assert.equal(without.researchMultiplier, 1);
  assert.equal(withResearch.baseTotal, without.baseTotal, '素点は同じ');
  assert.equal(
    withResearch.total,
    Math.round(withResearch.baseTotal * 1.3 * 10) / 10,
    '素点 × 倍率 になっている'
  );
  assert.ok(
    withResearch.total > without.total,
    `リサーチした会社が上でなければならない (${withResearch.total} vs ${without.total})`
  );
  assert.equal(withResearch.rank, 1);
  assert.equal(without.rank, 2);
});

test('リサーチ加点だけでは、経営で大きく差がついた会社を逆転できない', () => {
  // 「調べただけで勝てる」ゲームにしないための歯止め。
  // 加点は素点への倍率なので、素点が低いままなら順位はひっくり返りません。
  const standings = computeStandings(rules, [
    {
      id: 'strong',
      name: 'はると',
      company: '経営good',
      score: { funds: 8000000, producer: 90, society: 60, totalProfit: 5000000 },
      research: emptyResearch(),
    },
    {
      id: 'weak',
      name: 'あおい',
      company: '経営bad',
      score: { funds: 1000000, producer: 0, society: 0, totalProfit: -2000000 },
      research: FULL,
    },
  ]);

  const strong = standings.total.find((x) => x.id === 'strong');
  const weak = standings.total.find((x) => x.id === 'weak');
  assert.equal(weak.researchMultiplier, 1.3);
  assert.ok(strong.total > weak.total, 'リサーチ満点でも、経営が伴わなければ勝てない');
});

test('★ 回答そのものが順位表に載る（実際の仕入れ計画に使うため）', () => {
  const { state, rules: r } = newRoom();
  const ids = ['あおい', 'はると'].map((n) => game.addPlayer(state, r, companies, { name: n }).player.id);
  game.setResearch(state, ids[0], FULL);
  game.start(state, r);
  ids.forEach((id) => game.submit(state, r, id, { cacao: 'fairtrade', sugar: 'fairtrade', price: 'mid' }));

  const snap = game.snapshot(state, r, { role: 'teacher' });
  const row = snap.standings.total.find((x) => x.id === ids[0]);

  // 先生画面とCSVはここから発注内容を作る
  assert.equal(row.research.producerName, FULL.producerName);
  assert.equal(row.research.cacaoPrice, FULL.cacaoPrice);
  assert.equal(row.research.sugarPrice, FULL.sugarPrice);
});

test('もう一度あそんでも、調べた内容は消えない', () => {
  const { state, rules: r } = newRoom();
  const a = game.addPlayer(state, r, companies, { name: 'あおい' }).player;
  game.addPlayer(state, r, companies, { name: 'はると' });
  game.setResearch(state, a.id, FULL);

  game.start(state, r);
  game.restart(state, r);

  assert.equal(
    state.players[a.id].research.producerName,
    FULL.producerName,
    '生産者を調べ直させる必要はない（点数だけリセットされる）'
  );
});

/* ================================================================== 前提条件 */

test('発注者の条件（初期資金300万円・1パレットずつ）が反映されている', () => {
  assert.equal(rules.game.startingFunds, 3000000, '最初に割り当てる額は300万円');
  assert.equal(rules.demand.base, 1, '1ラウンド＝1バッチ（カカオ1パレット＋砂糖1パレット）');
  assert.match(rules.game.quantity.note, /パレット/);

  // 300万円で、いちばん高い組み合わせの1年目が実行できること
  const costOf = (key) =>
    Math.max(...rules.decisions.find((d) => d.key === key).options.map((o) => o.unitCost ?? o.cost ?? 0));
  const worstCase = costOf('cacao') + costOf('sugar') + costOf('ad') + costOf('give');
  assert.ok(
    worstCase <= rules.game.startingFunds,
    `いちばん高い選択でも1年目を実行できる必要がある (${worstCase} > ${rules.game.startingFunds})`
  );
});

test('カカオは「輸入・国内・原料輸入」から選べる（発注者の指定）', () => {
  const cacao = rules.decisions.find((d) => d.key === 'cacao');
  const ids = cacao.options.map((o) => o.id);
  assert.ok(ids.includes('processed'), 'チョコレート原料としての輸入');
  assert.ok(ids.includes('market'), '国内調達');
  assert.ok(ids.includes('fairtrade'), 'FLO認証の直接輸入');

  // 認証は高いが、生産者への貢献が大きいという関係は保たれている
  const ft = cacao.options.find((o) => o.id === 'fairtrade');
  const mk = cacao.options.find((o) => o.id === 'market');
  assert.ok(ft.unitCost > mk.unitCost);
  assert.ok(ft.producer > mk.producer);
});
