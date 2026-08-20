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

      // ① 通信は成功しているので「電波を確認して」と案内してはいけない
      assert.deepEqual(
        errors.filter((e) => e.payload.code === 'network').map((e) => e.payload.message),
        [],
        '通信は成功しているのに、電波のせいだと案内してしまっている'
      );

      // ② ルームは作れているのだから、welcome を出して番号を見せなければならない
      assert.equal(welcomes.length, 1, 'ルームは作れているのに welcome が出ていない');
      assert.equal(welcomes[0].payload.state.code, '123456');
      assert.equal(welcomes[0].payload.token, 'teacher-token');

      // ③ 代わりに「リアルタイム更新だけが使えない」ことを伝える
      const notice = errors.find((e) => e.payload.code === 'realtimeUnavailable');
      assert.ok(notice, '劣化していることが利用者に伝わらない');
      assert.match(notice.payload.message, /自動更新/);
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
