/**
 * 得点計算のまとめ役。
 *
 * 計算式そのものは engine.ts（旧 shared/engine.js）にあり、
 * このファイルは「ルーム状態から得点を出す」ための薄い入口です。
 *
 * ★ 移行メモ: 得点ロジックは1行も変えていません。
 *    旧 server/room.js の standings() / snapshot() が呼んでいた処理を、
 *    ルーム状態（プレーンなオブジェクト）を受け取る純粋関数に置き換えただけです。
 */

import {
  computeStandings,
  buildInsights,
  applyResult,
  initialPlayerScore,
  normalizeValues,
} from './engine';
import type { RoomState, Ruleset, Standings, Insight, PlayerScore } from './types';

// 旧コードからの import 互換（他ファイルが scoring 経由でも取れるように）
export { computeStandings, buildInsights, applyResult, initialPlayerScore, normalizeValues };
export type { PlayerScore };

/** ルーム内の並び順どおりのプレイヤー配列 */
export function orderedPlayers(state: RoomState) {
  return state.order.map((id) => state.players[id]).filter(Boolean);
}

/**
 * 途中経過・最終のランキング。
 * 1ラウンドも解決していないうちは null（旧実装と同じ挙動）。
 */
export function standingsOf(state: RoomState, rules: Ruleset): Standings | null {
  if (!state.rounds.length) return null;
  return computeStandings(
    rules,
    orderedPlayers(state).map((p) => ({
      id: p.id,
      name: p.name,
      company: p.company,
      score: p.score,
    }))
  );
}

/** ふりかえり用の「気づき」。最終画面でのみ使います。 */
export function insightsOf(state: RoomState, rules: Ruleset, standings: Standings | null): Insight[] {
  if (state.phase !== 'final' || !standings) return [];
  return buildInsights(rules, standings);
}

/**
 * players テーブルへ書き戻す用の、プレイヤーごとの得点サマリ。
 * （ゲーム進行はこの値を読みません。SQLで集計・分析するための写しです）
 */
export function scoreProjection(state: RoomState) {
  return orderedPlayers(state).map((p) => ({
    player_id: p.id,
    nickname: p.name,
    company: p.company,
    color: p.color,
    icon: p.icon,
    token: p.token,
    is_bot: p.isBot,
    bot_strategy: p.botStrategy,
    score: Math.round(p.score.funds),
    producer_points: Math.round(p.score.producer),
    society_points: Math.round(p.score.society),
    submitted: p.submitted,
    connected: p.connected,
  }));
}
