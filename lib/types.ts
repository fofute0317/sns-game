/**
 * 型定義。
 *
 * ルールセット（config/rules.*.json）は「数値を JSON 側だけで変えられる」ことが
 * 設計の核なので、あえて厳密に固めず、参照するプロパティだけを型として置いています。
 * ここを固くしすぎると、JSON に項目を1つ足すたびに TypeScript が壊れます。
 */

/* ------------------------------------------------------------------ ルール */

export interface RuleOption {
  id: string;
  name: string;
  short?: string;
  desc?: string;
  learn?: string;
  default?: boolean;
  tier?: string;
  unitCost?: number;
  unitPrice?: number;
  cost?: number;
  demand?: number;
  producer?: number;
  society?: number;
  [k: string]: unknown;
}

export interface RuleDecisionGroup {
  key: string;
  kind: 'material' | 'price' | 'cost';
  slot?: string;
  enabled?: boolean;
  label: string;
  icon?: string;
  hint?: string;
  options: RuleOption[];
  [k: string]: unknown;
}

export interface RuleEventEffect {
  type: 'materialCost' | 'demand';
  mul: number;
  slot?: string;
  tier?: string;
  when?: Record<string, unknown>;
}

export interface RuleEvent {
  id: string;
  name?: string;
  icon?: string;
  headline?: string;
  body?: string;
  learn?: string;
  effects?: RuleEventEffect[];
}

export interface Ruleset {
  id: string;
  label: string;
  note?: string;
  sourceFile?: string;
  game: {
    rounds: number;
    roundUnit?: string;
    startingFunds: number;
    minPlayers: number;
    maxPlayers: number;
    currencyLabel?: string;
    quantity?: { unitLabel?: string; unitSize?: number; decimals?: number };
    currency?: { unit?: number; unitLabel?: string };
    [k: string]: unknown;
  };
  demand: {
    base: number;
    randomness: number;
    floor?: number;
    mode?: 'independent' | 'share';
    share?: { perPlayer?: number; sensitivity?: number };
    [k: string]: unknown;
  };
  decisions: RuleDecisionGroup[];
  events: {
    list: RuleEvent[];
    mode?: string;
    fixedOrder?: string[];
    firstRound?: string;
    noRepeat?: boolean;
  };
  scoring: {
    weights: { profit: number; producer: number; society: number };
    normalization?: string;
    research?: {
      label?: string;
      note?: string;
      /** 1項目あたりの加点率（既定 0.1 = 10%） */
      bonusPerItem?: number;
      /** 「明確に書けている」とみなす最低文字数 */
      minChars?: number;
      /** 参考リンク（FLOCERT の認証事業者検索など） */
      links?: Array<{ label: string; url: string }>;
      items?: ResearchField[];
    };
    [k: string]: unknown;
  };
  help?: { flow?: string[] };
  reflection?: { title?: string; questions?: string[] };
  [k: string]: unknown;
}

/* ------------------------------------------------------------------ ゲーム */

export type Decision = Record<string, string>;

/* ------------------------------------------------------------------ リサーチ */

/**
 * 生徒が調べて入力する「本物の調達情報」。
 *
 * 発注者の狙い: 上位チームの回答をそのまま実際の仕入れ計画に使う。
 * そのため入力は自由記述で受け取り、CSVにそのまま書き出せる形で保持します。
 * FLOCERT の認証事業者検索 (https://www.flocert.net/fairtrade-customer-search/) で調べます。
 */
export interface ResearchAnswers {
  /** ① フェアトレード認証生産者名（FLO ID / 組織名） */
  producerName: string;
  /** ② 生産者情報（国・地域・組合の規模・生産品目など） */
  producerInfo: string;
  /** ③ フェアトレードプレミアムが何に使われているか */
  premiumUse: string;
  /** ④ フェアトレードカカオ豆の価格（根拠つき） */
  cacaoPrice: string;
  /** ⑤ フェアトレード砂糖の価格（根拠つき） */
  sugarPrice: string;
}

/** リサーチ1項目の採点結果 */
export interface ResearchItemScore {
  key: keyof ResearchAnswers;
  label: string;
  filled: boolean;
  /** 加点対象の項目か（発注者指定: ①〜③のみ +10%） */
  bonus: boolean;
  value: string;
}

/** ルール側で定義するリサーチの設問 */
export interface ResearchField {
  key: keyof ResearchAnswers;
  label: string;
  hint: string;
  placeholder: string;
  /** true の項目だけが総合得点への加点対象（発注者指定: ①〜③） */
  bonus: boolean;
}

/** リサーチ全体の採点結果 */
export interface ResearchScore {
  items: ResearchItemScore[];
  /** 加点対象のうち、条件を満たした数 */
  filledBonusCount: number;
  /** 総合得点にかける倍率（例: 3項目で 1.3） */
  multiplier: number;
  /** 記入済みの項目数（加点対象外も含む） */
  filledCount: number;
  totalCount: number;
}

export interface PlayerScore {
  funds: number;
  producer: number;
  society: number;
  totalProfit: number;
}

export interface RoundResult {
  playerId: string;
  decision: Decision;
  auto: boolean;
  eventId: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  revenue: number;
  materialCost: number;
  adCost: number;
  giveCost: number;
  profit: number;
  producerGain: number;
  societyGain: number;
  factors: { price: number; ad: number; ethical: number; event: number; luck: number };
  eventApplied: boolean;
}

export interface RoundRecord {
  round: number;
  eventId: string;
  closedBy: 'all' | 'teacher' | 'time';
  at: number;
  results: RoundResult[];
}

export interface StandingRow {
  id: string;
  name: string;
  company: string;
  funds: number;
  producerPoints: number;
  societyPoints: number;
  normalized: { profit: number; producer: number; society: number };
  parts: { profit: number; producer: number; society: number };
  /** リサーチ加点を掛ける前の素点 */
  baseTotal: number;
  /** 生徒が調べて入力した回答そのもの（先生画面とCSVで使う） */
  research: ResearchAnswers;
  /** リサーチによる倍率（1.0 = 加点なし、1.3 = 3項目達成） */
  researchMultiplier: number;
  /** リサーチで満たした加点項目の数 */
  researchCount: number;
  /** 素点 × リサーチ倍率 */
  total: number;
  value: number;
  rank: number;
}

export interface Standings {
  profit: StandingRow[];
  producer: StandingRow[];
  society: StandingRow[];
  total: StandingRow[];
}

export interface Insight {
  type: string;
  text: string;
  ask: string;
}

/* ------------------------------------------------------------------ ルーム */

export type Phase = 'lobby' | 'decision' | 'result' | 'final';

export interface RoomPlayer {
  id: string;
  name: string;
  company: string;
  color: string;
  icon: string;
  token: string;
  isBot: boolean;
  botStrategy: string | null;
  connected: boolean;
  lastSeen: number;
  score: PlayerScore;
  draft: Decision;
  submitted: boolean;
  submittedDecision: Decision | null;
  /** 調べて入力した調達情報（ラウンドごとではなく、1ゲームに1つ） */
  research: ResearchAnswers;
}

export interface RoomOptions {
  maxPlayers: number;
  demandMode: 'independent' | 'share';
  timerSec: number;
  autoAdvance: boolean;
}

/**
 * ルームの状態そのもの。旧 Room.toJSON() と同じ形です。
 * これが丸ごと rooms.game_state (JSONB) に入り、唯一の正となります。
 */
export interface RoomState {
  code: string;
  ruleId: string;
  seed: string;
  createdAt: number;
  updatedAt: number;
  options: RoomOptions;
  teacherToken: string;
  teacherConnected: boolean;
  phase: Phase;
  round: number;
  finalStageIndex: number;
  closed: boolean;
  deadline: number | null;
  eventPlan: string[];
  rounds: RoundRecord[];
  order: string[];
  players: Record<string, RoomPlayer>;
}

export interface Viewer {
  role: 'teacher' | 'player';
  playerId?: string | null;
}

export interface Snapshot {
  code: string;
  phase: Phase;
  round: number;
  totalRounds: number;
  ruleId: string;
  ruleLabel: string;
  demandMode: string;
  maxPlayers: number;
  minPlayers: number;
  autoAdvance: boolean;
  timerSec: number;
  deadline: number | null;
  teacherConnected: boolean;
  closed: boolean;
  finalStage: string;
  finalStageIndex: number;
  finalStageCount: number;
  event: Partial<RuleEvent> | null;
  players: Array<{
    id: string;
    name: string;
    company: string;
    color: string;
    icon: string;
    connected: boolean;
    isBot: boolean;
    submitted: boolean;
    funds: number;
    producer: number;
    society: number;
    /** リサーチの加点項目をいくつ満たしたか（先生の進捗確認用） */
    researchCount: number;
  }>;
  submittedCount: number;
  playerCount: number;
  rounds: Array<{ round: number; eventId: string; closedBy: string; results: RoundResult[] }>;
  standings: Standings | null;
  insights: Insight[];
  updatedAt: number;
  you?: {
    id: string;
    name: string;
    company: string;
    color: string;
    icon: string;
    score: PlayerScore;
    draft: Decision;
    submitted: boolean;
    requiredKeys: string[];
    research: ResearchAnswers;
    researchScore: ResearchScore;
  };
  /** リサーチの設問定義（画面はこれを見てフォームを組み立てる） */
  researchFields?: Array<{ key: string; label: string; hint: string; bonus: boolean; placeholder: string }>;
}

/** Realtime で流すイベント種別 */
export type GameEventType =
  | 'PLAYER_JOINED'
  | 'PLAYER_LEFT'
  | 'GAME_STARTED'
  | 'ROUND_UPDATED'
  | 'ANSWER_SUBMITTED'
  | 'SCORE_UPDATED'
  | 'GAME_FINISHED'
  | 'ROOM_CLOSED'
  | 'PLAYER_KICKED'
  | 'STATE_CHANGED';

/* ------------------------------------------------------------------ 操作の一覧
 *
 * /api/game/update が受け付ける操作。
 *
 * ★ ここを唯一の正とし、クライアント（lib/realtime.ts）とサーバ
 *   （app/api/game/update/route.ts）の両方がこの一覧を読みます。
 *
 *   以前、サーバ側にだけ 'research' を足してクライアント側の switch に
 *   足し忘れ、生徒の画面で「この操作はできません: research」と出る不具合が
 *   起きました。一覧を1か所にすれば、片方だけ直し忘れることがなくなります。
 * ------------------------------------------------------------------ */

/** 生徒ができる操作 */
export const PLAYER_UPDATE_ACTIONS = ['draft', 'research', 'unsubmit', 'leave'] as const;

/** 先生だけができる操作 */
export const TEACHER_UPDATE_ACTIONS = [
  'forceResolve',
  'next',
  'back',
  'restart',
  'addBot',
  'removePlayer',
  'setOptions',
  'closeRoom',
] as const;

/** /api/game/update が受け付けるすべての操作 */
export const UPDATE_ACTIONS = [...PLAYER_UPDATE_ACTIONS, ...TEACHER_UPDATE_ACTIONS] as const;

export type UpdateAction = (typeof UPDATE_ACTIONS)[number];
