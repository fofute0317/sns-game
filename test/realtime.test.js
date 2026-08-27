/**
 * 通信クライアント（lib/realtime.ts）のテスト。
 *
 * ここで守りたいのは、**エラーの原因を正しく伝えること**です。
 *
 * 教室でのトラブル切り分けは、画面に出るメッセージが頼りです。
 * 「通信できませんでした（電波を確認）」と出たのに実際は設定漏れだった、というような
 * 誤った案内をすると、先生は直せない場所をいくら探しても原因に辿り着けません。
 *
 * とくに Vercel では NEXT_PUBLIC_* がビルド時にブラウザへ埋め込まれるため、
 * 「サーバは動くのに、ブラウザ側の Supabase 設定だけが空」という状態が現実に起きます。
 * その場合でも HTTP だけで授業が成立しなければなりません
 * （状態は /api/rooms/state で取得できるので、Realtime は必須ではない）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { Net } = await import('../.test-build/lib/realtime.js');

/* ------------------------------------------------ ブラウザ環境の代用 */

function installBrowser() {
  const store = () => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  };
  globalThis.sessionStorage = store();
  globalThis.localStorage = store();
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** ルームを1つ作れる、最小のサーバ代役。呼ばれたURLを記録して返す。 */
function installFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });

    if (u.startsWith('/api/rooms/create')) {
      return jsonResponse(200, {
        roomCode: '123456',
        roomId: 'room-uuid',
        role: 'teacher',
        token: 'teacher-token',
        playerId: null,
        rules: { game: { rounds: 5 } },
        state: { code: '123456', phase: 'lobby', round: 0, deadline: null },
      });
    }
    if (u.startsWith('/api/rooms/state')) {
      return jsonResponse(200, {
        version: 1,
        state: { code: '123456', phase: 'lobby', round: 0, deadline: null },
      });
    }
    return jsonResponse(404, { error: 'not found', code: 'noRoom' });
  };
  return calls;
}

/** 発火したイベントを集める */
function collect(net) {
  const seen = [];
  for (const type of ['welcome', 'state', 'error', 'ready', 'status', 'roomClosed', 'reconnecting']) {
    net.on(type, (payload) => seen.push({ type, payload }));
  }
  return seen;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

/** ブラウザ側の Supabase 設定が空の状態を作る（Vercel の入れ忘れを再現） */
function withoutPublicEnv(fn) {
  const saved = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return (async () => {
    try {
      return await fn();
    } finally {
      if (saved.url) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.key) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.key;
    }
  })();
}

/* ================================================================== */

test('ブラウザ側の Supabase 設定が空でも、ルーム作成は成功として扱われる', async () => {
  installBrowser();
  installFetch();

  await withoutPublicEnv(async () => {
    const net = new Net('teacher');
    const seen = collect(net);
    try {
      net.send({ t: 'createRoom', ruleset: 'mvp' });
      await flush();

      const errors = seen.filter((e) => e.type === 'error');
      const welcomes = seen.filter((e) => e.type === 'welcome');

      // ① ルームは作れているのだから、welcome を出して番号を見せなければならない
      assert.equal(welcomes.length, 1, 'ルームは作れているのに welcome が出ていない');
      assert.equal(welcomes[0].payload.state.code, '123456');
      assert.equal(welcomes[0].payload.token, 'teacher-token');

      // ② 画面には何も警告を出さない（授業の邪魔をしない）。
      //    更新が数秒遅れるだけで操作は妨げられないため、
      //    気づく必要がある開発・保守向けに console.warn だけを残す方針。
      assert.deepEqual(
        errors.map((e) => e.payload.code),
        [],
        '操作できているのに画面へ警告を出してしまっている'
      );
    } finally {
      net.disconnect();
    }
  });
});

test('Realtime を張れないときは、再取得（ポーリング）で授業を続けられる', async () => {
  installBrowser();
  const calls = installFetch();

  await withoutPublicEnv(async () => {
    const net = new Net('teacher');
    try {
      net.send({ t: 'createRoom', ruleset: 'mvp' });
      await flush();

      // 購読に失敗しても、状態を取りに行く手段が残っていること
      await net.refreshState();

      const stateCalls = calls.filter((c) => c.url.startsWith('/api/rooms/state'));
      assert.ok(stateCalls.length >= 1, '状態を取得できていない');
      assert.ok(stateCalls[0].url.includes('code=123456'), 'ルーム番号が付いていない');
      assert.ok(stateCalls[0].url.includes('token=teacher-token'), 'トークンが付いていない');
    } finally {
      net.disconnect();
    }
  });
});

test('本当に通信できないときは、通信エラーとして案内する', async () => {
  installBrowser();
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const net = new Net('teacher');
  const seen = collect(net);
  try {
    net.send({ t: 'createRoom', ruleset: 'mvp' });
    await flush();

    const errors = seen.filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.code, 'network');
    assert.match(errors[0].payload.message, /通信できませんでした/);
  } finally {
    net.disconnect();
  }
});

test('サーバが理由つきで断ったときは、その理由をそのまま見せる', async () => {
  installBrowser();
  globalThis.fetch = async () =>
    jsonResponse(400, { error: '定員（6人）に達しています。', code: 'cannotJoin' });

  const net = new Net('player');
  const seen = collect(net);
  try {
    net.send({ t: 'joinRoom', code: '123456', name: 'たろう' });
    await flush();

    const errors = seen.filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.code, 'cannotJoin');
    assert.match(errors[0].payload.message, /定員/);
  } finally {
    net.disconnect();
  }
});

test('ルームが終了していたら、セッション切れではなく終了として伝える', async () => {
  installBrowser();
  globalThis.fetch = async () =>
    jsonResponse(410, { error: 'このルームは終了しています。', code: 'roomClosed' });

  const net = new Net('player');
  const seen = collect(net);
  try {
    net.send({ t: 'resume', code: '123456', token: 'tok' });
    await flush();

    assert.ok(
      seen.some((e) => e.type === 'roomClosed'),
      'ゲーム終了が伝わっていない'
    );
    assert.equal(
      seen.some((e) => e.type === 'ready'),
      false,
      '終了なのに参加画面に戻してしまっている'
    );
  } finally {
    net.disconnect();
  }
});

/* ================================================================== 操作の一覧 */

/**
 * クライアントとサーバが、同じ操作の一覧を見ていることを確かめる。
 *
 * 実際に、サーバ側にだけ 'research' を追加してクライアント側の switch に
 * 足し忘れ、生徒の画面に「この操作はできません: research」と出る不具合が起きました。
 * 一覧は lib/types.ts に1つだけ置き、両側がそこを読む形にしています。
 */

const { UPDATE_ACTIONS, PLAYER_UPDATE_ACTIONS, TEACHER_UPDATE_ACTIONS } = await import(
  '../.test-build/lib/types.js'
);
const fsMod = await import('node:fs');

test('生徒・先生の操作が重複なく1つの一覧にまとまっている', () => {
  const all = [...PLAYER_UPDATE_ACTIONS, ...TEACHER_UPDATE_ACTIONS];
  assert.deepEqual([...UPDATE_ACTIONS], all);
  assert.equal(new Set(all).size, all.length, '同じ操作が2回入っている');
  // 発注者の要望で追加した操作が、ちゃんと生徒側に入っていること
  assert.ok(PLAYER_UPDATE_ACTIONS.includes('research'));
});

test('サーバが実装している操作は、すべてクライアントから送れる', () => {
  const route = fsMod.readFileSync(
    new URL('../app/api/game/update/route.ts', import.meta.url),
    'utf8'
  );

  // 先生用 switch の case と、生徒用の if (action === '...') を拾う
  const implemented = new Set([
    ...[...route.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]),
    ...[...route.matchAll(/action === '([a-zA-Z]+)'/g)].map((m) => m[1]),
  ]);
  // leave は if/else の最後（明示的な比較が無い）なので足しておく
  implemented.add('leave');

  const missing = [...implemented].filter((a) => !UPDATE_ACTIONS.includes(a));
  assert.deepEqual(
    missing,
    [],
    `サーバにあるのに UPDATE_ACTIONS に無い操作: ${missing.join(', ')}`
  );
});

test('一覧にある操作は、クライアントが「できません」と言わずに送信する', async () => {
  installBrowser();
  const calls = installFetch();

  const net = new Net('teacher');
  const seen = collect(net);
  try {
    // 参加済みの状態にしておく
    net.send({ t: 'createRoom', ruleset: 'mvp' });
    await flush();
    seen.length = 0;

    for (const action of UPDATE_ACTIONS) {
      if (action === 'leave') continue; // leave は退出処理なので別扱い
      net.send({ t: action });
    }
    await flush();

    const rejected = seen
      .filter((e) => e.type === 'error' && e.payload.code === 'badRequest')
      .map((e) => e.payload.message);
    assert.deepEqual(rejected, [], `クライアントが送れない操作がある: ${rejected.join(' / ')}`);

    const posted = calls.filter((c) => c.url === '/api/game/update').length;
    assert.equal(posted, UPDATE_ACTIONS.length - 1, 'すべての操作が /api/game/update に送られる');
  } finally {
    net.disconnect();
  }
});

test('本当に知らない操作は、これまでどおり拒否する', async () => {
  installBrowser();
  installFetch();
  const net = new Net('teacher');
  const seen = collect(net);
  try {
    net.send({ t: 'nonexistentAction' });
    await flush();
    const errors = seen.filter((e) => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].payload.code, 'badRequest');
  } finally {
    net.disconnect();
  }
});
