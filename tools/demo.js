/**
 * 動作確認用: 実際に動いている環境へ HTTP でつなぎ、1ゲームを最後まで通します。
 *
 *   npm run dev                                    # 別のターミナルで起動しておく
 *   node tools/demo.js                             # http://localhost:3000 に対して実行
 *   node tools/demo.js https://example.vercel.app  # 公開先に対して実行
 *
 *   PLAYERS=6 node tools/demo.js                   # 人数を変える（既定4人）
 *   HUMANS=2  node tools/demo.js                   # うち2人を「生徒として参加」させる
 *
 * デプロイしたあと、「本当に最後まで遊べる状態になっているか」を
 * ブラウザを開かずに確認できます。Supabase の接続・楽観ロック・進行の
 * すべてを実際に通るため、授業前のチェックに使えます。
 *
 * ★ 移行メモ: 旧版は WebSocket（/ws）につないでいました。
 *    サーバレス化で WebSocket サーバが無くなったため、HTTP API 版に書き換えています。
 *    Realtime の購読はしません（ここで見たいのは「進行が成立するか」だけなので、
 *    先生役が状態を取りに行く形で十分です）。
 */

const target = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const PLAYERS = Number(process.env.PLAYERS || 4);
const HUMANS = Math.min(Number(process.env.HUMANS || 0), PLAYERS);

const fmt = (n) => Math.round(n).toLocaleString('ja-JP');

/* ------------------------------------------------------------------ HTTP */

async function call(path, body) {
  const res = await fetch(`${target}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data.error || ''} [${data.code || ''}]`);
  return data;
}

async function getState(code, token) {
  const res = await fetch(
    `${target}/api/rooms/state?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`,
    { cache: 'no-store' }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/rooms/state → ${res.status} ${data.error || ''}`);
  return data.state;
}

/* ------------------------------------------------------------------ 本編 */

async function main() {
  console.log(`\n接続先: ${target}`);

  /* --- 1. 死活確認 ------------------------------------------------ */

  const health = await fetch(`${target}/api/health`).then((r) => r.json());
  if (!health.ok) throw new Error(`サーバが不調です: ${health.message || health.db}`);
  console.log(`サーバ: DB ${health.db} / 応答 ${health.latencyMs}ms / 進行中のルーム ${health.rooms}件\n`);

  /* --- 2. 先生がルームを作る -------------------------------------- */

  const room = await call('/api/rooms/create', {
    ruleset: 'mvp',
    options: { maxPlayers: Math.max(PLAYERS, 2) },
  });
  const code = room.roomCode;
  const teacherToken = room.token;
  const rules = room.rules;

  console.log(`ルーム作成: ${code}`);
  console.log(`参加URL   : ${target}/j/${code}\n`);

  /* --- 3. 参加者をそろえる ---------------------------------------- */

  // 生徒役（HTTPで実際に /api/rooms/join を叩く）
  const humans = [];
  for (let i = 0; i < HUMANS; i++) {
    const joined = await call('/api/rooms/join', { code, name: `テスト${i + 1}` });
    humans.push({ id: joined.playerId, token: joined.token, name: `テスト${i + 1}` });
  }
  // 残りは練習用AIで埋める
  for (let i = HUMANS; i < PLAYERS; i++) {
    await call('/api/game/update', { code, token: teacherToken, action: 'addBot' });
  }

  let state = await getState(code, teacherToken);
  if (state.playerCount !== PLAYERS) {
    throw new Error(`参加人数が合いません（期待 ${PLAYERS} / 実際 ${state.playerCount}）`);
  }
  console.log(`参加者 ${PLAYERS}人（生徒役 ${HUMANS}人 / AI ${PLAYERS - HUMANS}人）:`);
  for (const p of state.players) {
    console.log(`  ${p.icon} ${String(p.company).padEnd(12)} ${p.name}${p.isBot ? ' [AI]' : ''}`);
  }

  /* --- 4. 開始 ---------------------------------------------------- */

  await call('/api/game/start', { code, token: teacherToken });
  const total = rules.game.rounds;

  /* --- 5. 各ラウンド ---------------------------------------------- */

  // 生徒役が選ぶ手（毎ラウンド同じ。ここで見たいのは進行の成立なので固定でよい）
  const humanPlay = { cacao: 'fairtrade', sugar: 'direct', price: 'mid', ad: 'small', give: 'mid' };

  for (let round = 1; round <= total; round++) {
    // 生徒役が提出する（AIは決定フェーズ開始時に提出済み）
    for (const h of humans) {
      await call('/api/game/submit', { code, token: h.token, decision: humanPlay });
    }

    state = await getState(code, teacherToken);

    // 全員そろっていなければ先生が締め切る
    if (state.phase === 'decision') {
      await call('/api/game/update', { code, token: teacherToken, action: 'forceResolve' });
      state = await getState(code, teacherToken);
    }
    if (state.phase !== 'result') {
      throw new Error(`${round}年目の結果が出ません（phase=${state.phase}）`);
    }

    const entry = state.rounds.at(-1);
    const ev = rules.events.list.find((e) => e.id === entry.eventId);
    console.log(`\n── ${round}${rules.game.roundUnit || ''} ── ${ev?.icon ?? ''} ${ev?.name ?? ''}`);

    const byId = new Map(state.players.map((p) => [p.id, p]));
    for (const r of [...entry.results].sort((a, b) => b.profit - a.profit)) {
      const p = byId.get(r.playerId);
      const d = r.decision;
      console.log(
        `   ${String(p.company).padEnd(12)} ${String(d.cacao).padEnd(9)}/${String(d.sugar).padEnd(9)} ` +
          `${String(d.price).padEnd(4)} 販売${r.quantity.toFixed(1)} 利益${String(fmt(r.profit)).padStart(7)} ` +
          `資金${String(fmt(p.funds)).padStart(8)}`
      );
    }

    await call('/api/game/update', { code, token: teacherToken, action: 'next' });
  }

  /* --- 6. 最終結果 ------------------------------------------------ */

  state = await getState(code, teacherToken);
  if (state.phase !== 'final') throw new Error(`最終画面に入りません（phase=${state.phase}）`);

  const s = state.standings;

  console.log('\n════ ① 利益ランキング ════');
  for (const r of s.profit) console.log(`  ${r.rank}位  ${String(r.company).padEnd(12)} ${fmt(r.funds)}`);

  console.log('\n════ ② 総合ランキング ════');
  for (const r of s.total) {
    console.log(
      `  ${r.rank}位  ${String(r.company).padEnd(12)} ${String(r.total).padStart(5)}点  ` +
        `(利益${r.parts.profit} / 生産者${r.parts.producer} / 社会${r.parts.society})`
    );
  }

  if (state.insights?.length) {
    console.log('\n════ 話し合いのヒント ════');
    for (const i of state.insights) console.log(`  ${i.text}\n    → ${i.ask}`);
  }

  const flipped = s.profit[0].id !== s.total[0].id;
  console.log(`\n利益1位と総合1位は ${flipped ? '入れ替わりました 🔀' : '同じでした'}`);

  /* --- 7. 生徒からも同じ進行が見えているか ------------------------ */

  for (const h of humans) {
    const mine = await getState(code, h.token);
    if (mine.phase !== state.phase || mine.round !== state.round) {
      throw new Error(`${h.name} の画面が先生と食い違っています`);
    }
    if (!mine.you || mine.you.id !== h.id) throw new Error(`${h.name} の自分情報が取れません`);
    if (JSON.stringify(mine.players).includes('draft')) {
      throw new Error(`${h.name} に他人の選択が見えています（秘密が漏れています）`);
    }
  }
  if (humans.length) console.log(`\n生徒役 ${humans.length}人とも、先生と同じ進行を見ています。`);

  /* --- 8. 片付け -------------------------------------------------- */

  await call('/api/game/update', { code, token: teacherToken, action: 'closeRoom' });

  console.log('\n✅ 1ゲームを最後まで通せました。\n');
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
