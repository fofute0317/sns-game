/**
 * リアルタイム通信クライアント（Supabase Realtime + Vercel Functions）。
 *
 * ★ 移行メモ（このファイルが今回の移行の心臓部です）
 *
 *   旧: public/js/net.js … 自前の WebSocket サーバ（/ws）に1本つなぎ、
 *                          そこで「操作の送信」と「状態の受信」の両方をしていた。
 *   新: このファイル      … 2つに分けます。
 *                          操作の送信 → HTTP POST（/api/...）… Vercel Functions
 *                          状態の受信 → Supabase Realtime の broadcast チャンネル
 *
 *   ■ なぜ状態そのものを broadcast に載せないのか
 *     生徒ごとに「見えてよい情報」が違うからです。
 *     決定フェーズ中、他人がどれを選んだかは見えてはいけません（snapshot の you だけが自分用）。
 *     全員に同じ本文を配ると、ブラウザの開発者ツールから他人の選択が読めてしまいます。
 *     そこで broadcast は「変わったよ」という合図だけにし、
 *     各自が自分のトークンを付けて /api/rooms/state を取りに行く形にしています。
 *     （往復が1回増えますが、実測で数十ミリ秒。授業では体感できません）
 *
 *   ■ 旧 net.js との互換性
 *     Net クラスの外から見える形（on / send / connect / セッション保存）は
 *     旧実装とまったく同じにしてあります。
 *     そのため teacher.js / play.js は import 先を変えるだけで、
 *     画面のロジックには一切手を入れていません。
 */

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { GameEventType } from './types';

/** ルームコード → Realtime チャンネル名 */
export function channelFor(code: string): string {
  return `room:${code}`;
}

/** Realtime で流すイベント名（サーバ・クライアント共通） */
export const EVENTS: Record<string, GameEventType> = {
  PLAYER_JOINED: 'PLAYER_JOINED',
  PLAYER_LEFT: 'PLAYER_LEFT',
  GAME_STARTED: 'GAME_STARTED',
  ROUND_UPDATED: 'ROUND_UPDATED',
  ANSWER_SUBMITTED: 'ANSWER_SUBMITTED',
  SCORE_UPDATED: 'SCORE_UPDATED',
  GAME_FINISHED: 'GAME_FINISHED',
  ROOM_CLOSED: 'ROOM_CLOSED',
  PLAYER_KICKED: 'PLAYER_KICKED',
  STATE_CHANGED: 'STATE_CHANGED',
};

const ALL_EVENTS = Object.keys(EVENTS);

/** 合図が連続で来たときに、状態の取得を1回にまとめる待ち時間 */
const COALESCE_MS = 60;

/** Realtime が動いているときの保険。ゆっくり取りに行く。 */
const POLL_MS = 4000;

/** Realtime が張れなかったときは、これだけが更新手段になるので少し短くする。 */
const FALLBACK_POLL_MS = 2000;

interface Session {
  code: string;
  token: string;
  role: 'teacher' | 'player';
  playerId: string | null;
}

type Handler = (payload: any) => void;

export class Net {
  role: 'teacher' | 'player';
  session: Session | null = null;
  connected = false;

  private handlers = new Map<string, Set<Handler>>();
  private supabase: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private subscribedCode: string | null = null;
  private realtimeOk = false;
  private noticedRealtime = false;
  private pollInterval = 0;
  private myPlayerId: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private pendingRefresh = false;
  private closedManually = false;

  constructor(role: 'teacher' | 'player') {
    this.role = role;
  }

  /* ---------------- イベント（旧 net.js と同じ） ---------------- */

  on(type: string, fn: Handler): this {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
    return this;
  }

  emit(type: string, payload?: unknown): void {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[net] ${type} ハンドラでエラー`, err);
      }
    }
  }

  /* ---------------- セッション（旧 net.js と同じ） ----------------
   *
   * sessionStorage … タブ単位。更新・スリープ復帰では自動で戻る（教室での主なケース）
   * localStorage   … タブを閉じた場合の保険。参加画面に「続きから戻る」を出すために使う
   */

  get storageKey(): string {
    return `ftc.session.${this.role}`;
  }

  loadSession(): Session | null {
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      this.session = raw ? JSON.parse(raw) : null;
    } catch {
      this.session = null;
    }
    return this.session;
  }

  /** タブを閉じた場合の保険（自動復帰はしない） */
  loadBackupSession(): Session | null {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  saveSession(session: Session): void {
    this.session = session;
    this.myPlayerId = session.playerId;
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(session));
      localStorage.setItem(this.storageKey, JSON.stringify(session));
    } catch {
      /* プライベートモード等では保存できないが、動作は続行する */
    }
  }

  clearSession(): void {
    this.session = null;
    this.myPlayerId = null;
    try {
      sessionStorage.removeItem(this.storageKey);
      localStorage.removeItem(this.storageKey);
    } catch {
      /* noop */
    }
  }

  /* ---------------- 接続 ---------------- */

  connect(): void {
    this.closedManually = false;
    this.loadSession();

    if (this.session?.code && this.session?.token) {
      // 前回の続きがあれば、まず復帰を試す
      void this.request('/api/rooms/resume', { code: this.session.code, token: this.session.token }, 'resume');
    } else {
      this.setConnected(true);
      this.emit('ready');
    }
  }

  disconnect(): void {
    this.closedManually = true;
    this.teardown();
  }

  private teardown(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.refreshTimer = this.deadlineTimer = null;
    this.pollTimer = null;
    if (this.channel && this.supabase) {
      try {
        void this.supabase.removeChannel(this.channel);
      } catch {
        /* noop */
      }
    }
    this.channel = null;
    this.subscribedCode = null;
    this.pollInterval = 0;
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) return;
    this.connected = next;
    this.emit('status', { connected: next });
  }

  /* ---------------- Realtime 購読 ---------------- */

  /**
   * ルームの変化を追いはじめる。
   *
   * ★ Realtime が張れなくても、授業は続けられなければなりません。
   *   状態は HTTP（/api/rooms/state）だけでも取得できるので、
   *   購読の失敗は「更新が数秒遅くなる」だけの劣化であって、致命的ではありません。
   *
   *   実際に張れない原因はいろいろあります。
   *     - NEXT_PUBLIC_SUPABASE_* がビルド時に未設定（Vercel でよくある）
   *     - 学校のネットワークが WebSocket を遮断している
   *     - Supabase プロジェクトが一時停止している
   *   どれも「参加できない」わけではないので、必ず再取得に切り替えて続行します。
   */
  private async startWatching(code: string): Promise<void> {
    try {
      await this.subscribe(code);
      this.realtimeOk = true;
    } catch (err) {
      this.subscribedCode = null; // あとで張り直せるようにしておく
      this.realtimeOk = false;
      console.warn(
        '[net] Realtime に接続できませんでした。数秒ごとの再取得で動作します:',
        (err as Error).message
      );
      // HTTP は生きているので「オンライン」のまま
      this.setConnected(true);
      this.noticeRealtimeUnavailable();
    } finally {
      // Realtime の成否にかかわらず、保険のポーリングは必ず動かす
      this.startPolling();
    }
  }

  /** 劣化していることを1度だけ知らせる（毎回出すと授業中に邪魔になる） */
  private noticeRealtimeUnavailable(): void {
    if (this.noticedRealtime) return;
    this.noticedRealtime = true;
    this.emit('error', {
      t: 'error',
      code: 'realtimeUnavailable',
      message: 'リアルタイム更新に接続できませんでした。画面は数秒ごとに自動更新されます。',
    });
  }

  /** 状態の再取得を定期実行する（Realtime が動いていても保険として併走） */
  private startPolling(): void {
    if (this.closedManually) return;
    const interval = this.realtimeOk ? POLL_MS : FALLBACK_POLL_MS;
    if (this.pollTimer && this.pollInterval === interval) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollInterval = interval;
    this.pollTimer = setInterval(() => {
      if (!this.closedManually && this.session) void this.refreshState();
    }, interval);
    // Node（テスト・tools）から使われたとき、この繰り返しタイマーだけで
    // プロセスが終了できなくなるのを防ぐ。ブラウザに unref は無いので任意呼び出し。
    (this.pollTimer as unknown as { unref?: () => void })?.unref?.();
  }

  private async subscribe(code: string): Promise<void> {
    if (this.closedManually) return;
    if (this.channel) {
      // すでに同じルームを見ているなら張り直さない
      // （channel.topic の内部表記に依存しないよう、購読中のコードを自分で覚えておく）
      if (this.subscribedCode === code) return;
      this.teardown();
    }

    const { supabaseBrowser } = await import('./supabase');
    this.supabase = supabaseBrowser();

    const channel = this.supabase.channel(channelFor(code), {
      config: { broadcast: { self: true, ack: false } },
    });

    for (const name of ALL_EVENTS) {
      channel.on('broadcast', { event: name }, ({ payload }) => this.onRealtime(name, payload));
    }

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        this.setConnected(true);
        void this.refreshState(); // 購読の隙間に起きた変化を拾う
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (!this.closedManually) {
          this.setConnected(false);
          this.emit('reconnecting', { attempt: 1 });
        }
      }
    });

    this.channel = channel;
    this.subscribedCode = code;
    // ポーリングは startWatching() が必ず張ります（購読に失敗しても動くように）
  }

  private onRealtime(type: string, payload: Record<string, any> = {}): void {
    if (type === EVENTS.ROOM_CLOSED) {
      this.clearSession();
      this.teardown();
      this.emit('roomClosed', { t: 'roomClosed', message: payload.message || 'ゲームが終了しました。' });
      return;
    }
    if (type === EVENTS.PLAYER_KICKED && payload.playerId && payload.playerId === this.myPlayerId) {
      this.clearSession();
      this.teardown();
      this.emit('kicked', { t: 'kicked', message: payload.message || '先生によって退出しました。' });
      return;
    }
    this.scheduleRefresh();
  }

  /** 短時間に来た合図をまとめて、状態の取得を1回にする */
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshState();
    }, COALESCE_MS);
  }

  /* ---------------- 状態の取得 ---------------- */

  async refreshState(): Promise<void> {
    if (!this.session?.code || !this.session?.token) return;
    if (this.inFlight) {
      this.pendingRefresh = true;
      return;
    }
    this.inFlight = true;
    try {
      const url =
        `/api/rooms/state?code=${encodeURIComponent(this.session.code)}` +
        `&token=${encodeURIComponent(this.session.token)}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) return this.handleError(data, 'refresh');
      this.setConnected(true);
      this.applyState(data.state);
    } catch {
      this.setConnected(false);
    } finally {
      this.inFlight = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.scheduleRefresh();
      }
    }
  }

  private applyState(state: any): void {
    if (!state) return;
    this.emit('state', { t: 'state', state });
    this.armDeadline(state);
  }

  /**
   * 制限時間の締め切り。
   *
   * 旧実装ではサーバの setTimeout が締め切っていました。
   * サーバレスにはタイマーが無いため、先生の画面が時間になったら
   * /api/game/tick を叩いて締め切りを起こします（サーバ側でも時刻を必ず再確認します）。
   * 先生画面が閉じていても、誰かが次に操作した時点で締め切られます。
   */
  private armDeadline(state: any): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (this.role !== 'teacher') return;
    if (state?.phase !== 'decision' || !state?.deadline) return;

    const wait = Math.max(0, state.deadline - Date.now()) + 400;
    this.deadlineTimer = setTimeout(() => {
      if (!this.session) return;
      void this.request('/api/game/tick', {}, 'tick');
    }, wait);
  }

  /* ---------------- 送信（旧 net.js と同じ send({t:...}) 形式） ---------------- */

  send(msg: Record<string, any>): boolean {
    void this.dispatch(msg);
    return true;
  }

  /** 旧 net.js は未接続時にためていたが、HTTP なので毎回そのまま送れる */
  sendNow(msg: Record<string, any>): boolean {
    return this.send(msg);
  }

  private async dispatch(msg: Record<string, any>): Promise<void> {
    const t = msg?.t;
    const auth = { code: this.session?.code, token: this.session?.token };

    switch (t) {
      case 'ping':
        this.emit('pong', { t: 'pong', at: Date.now() });
        return;

      /* ---- ルーム作成（先生） ---- */
      case 'createRoom':
        await this.request(
          '/api/rooms/create',
          { ruleset: msg.ruleset || 'mvp', options: msg.options || {} },
          'create'
        );
        return;

      /* ---- 参加（生徒） ---- */
      case 'joinRoom':
        await this.request('/api/rooms/join', { code: msg.code, name: msg.name }, 'join');
        return;

      /* ---- 再接続（更新・回線切断からの復帰） ---- */
      case 'resume':
        await this.request('/api/rooms/resume', { code: msg.code, token: msg.token }, 'resume');
        return;

      /* ---- 生徒の操作 ---- */
      case 'submit':
        await this.request('/api/game/submit', { ...auth, decision: msg.decision }, 'action');
        return;
      case 'start':
        await this.request('/api/game/start', auth, 'action');
        return;
      case 'leave':
        await this.request('/api/game/update', { ...auth, action: 'leave' }, 'leave');
        return;

      /* ---- そのほかはすべて /api/game/update に集約 ---- */
      case 'draft':
      case 'unsubmit':
      case 'forceResolve':
      case 'next':
      case 'back':
      case 'restart':
      case 'addBot':
      case 'removePlayer':
      case 'setOptions':
      case 'closeRoom':
        await this.request('/api/game/update', { ...auth, action: t, ...msg }, 'action');
        return;

      default:
        this.emit('error', { t: 'error', code: 'badRequest', message: `この操作はできません: ${t}` });
    }
  }

  /* ---------------- HTTP ---------------- */

  /**
   * ★ 通信の失敗と、応答を受け取ったあとの失敗を、必ず分けて扱います。
   *
   *   以前はここを1つの try で包んでいたため、
   *   「サーバは成功を返したのに、ブラウザ側の処理で例外が出た」場合でも
   *   『通信できませんでした。電波の状態を確認して…』と表示していました。
   *
   *   これは案内として真逆です。実際に起きたのは
   *   「Vercel で NEXT_PUBLIC_SUPABASE_* をビルド時に入れ忘れ、
   *     ブラウザ側の Supabase 設定だけが空だった」というケースで、
   *   電波をいくら確認しても直りません。
   *   （再現テストは test/realtime.test.js にあります）
   */
  private async request(
    path: string,
    body: Record<string, unknown>,
    kind: 'create' | 'join' | 'resume' | 'action' | 'leave' | 'tick' | 'refresh'
  ): Promise<void> {
    let res: Response;
    let data: any;

    // --- ここだけが「本当の通信エラー」の範囲 ---
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
      data = await res.json().catch(() => ({}));
    } catch {
      this.setConnected(false);
      if (kind === 'refresh' || kind === 'tick') return;
      this.emit('error', {
        t: 'error',
        code: 'network',
        message: '通信できませんでした。電波の状態を確認して、もう一度お試しください。',
      });
      return;
    }

    if (!res.ok) return this.handleError(data, kind);

    this.setConnected(true);

    // --- ここから先はブラウザ内の処理。落ちても通信の問題ではない ---
    try {
      if (kind === 'create' || kind === 'join' || kind === 'resume') {
        await this.welcome(data);
        return;
      }
      if (kind === 'leave') {
        this.clearSession();
        this.teardown();
        this.emit('left', { t: 'left' });
        return;
      }
      // 操作系は、返ってきた自分用スナップショットをそのまま反映する
      if (data.state) this.applyState(data.state);
    } catch (err) {
      console.error('[net] 応答の処理に失敗しました', err);
      this.emit('error', {
        t: 'error',
        code: 'client',
        message: '画面の更新に失敗しました。ページを再読み込みしてください。',
      });
    }
  }

  /** 旧 net.js の 'welcome' 相当。ここで購読を始める。 */
  private async welcome(data: any): Promise<void> {
    this.myPlayerId = data.playerId ?? null;

    this.saveSession({
      code: data.state.code,
      token: data.token,
      role: data.role,
      playerId: data.playerId ?? null,
    });

    await this.startWatching(data.state.code);

    this.emit('welcome', {
      t: 'welcome',
      role: data.role,
      token: data.token,
      playerId: data.playerId ?? null,
      rules: data.rules,
      strategies: data.strategies,
      state: data.state,
    });
    this.armDeadline(data.state);
  }

  /**
   * エラー処理。旧 net.js の判断をそのまま引き継いでいます。
   *
   * 「前回の続きに戻ろうとして戻れなかった」場合だけ、参加画面に戻す。
   * ここを区別しないと、生徒がルーム番号を打ち間違えたときにも
   * 黙って参加画面に戻るだけになり、何が悪かったのか分からなくなる。
   * （教室でいちばん多い操作ミスなので、必ず理由を出す）
   */
  private handleError(data: any, kind: string): void {
    const msg = {
      t: 'error',
      code: data?.code || 'error',
      message: data?.error || data?.message || 'エラーが発生しました。',
    };

    // ルームが終了していた場合は「セッション切れ」ではなく「ゲーム終了」として伝える。
    // （Realtime の ROOM_CLOSED が届かなかったとき、ポーリングがここに来る）
    if (msg.code === 'roomClosed') {
      this.clearSession();
      this.teardown();
      this.emit('roomClosed', { t: 'roomClosed', message: 'ゲームが終了しました。' });
      return;
    }

    if (msg.code === 'noSession' || msg.code === 'noRoom') {
      const wasResuming = kind === 'resume' || kind === 'refresh' || kind === 'tick';
      const hadSession = !!this.session;
      this.clearSession();
      this.teardown();
      if (wasResuming && hadSession) {
        this.emit('sessionLost', msg);
        this.setConnected(true);
        this.emit('ready');
        return;
      }
      // 復帰中でなければ、通常のエラーとして画面へ伝える（下へ流す）
    }

    this.emit('error', msg);
  }
}
