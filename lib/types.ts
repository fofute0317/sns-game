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
    [k: string]: unknown;
  };
  help?: { flow?: string[] };
  reflection?: { title?: string; questions?: string[] };
  [k: string]: unknown;
}

/* ------------------------------------------------------------------ ゲーム */

export type Decision = Record<string, string>;

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
  };
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
