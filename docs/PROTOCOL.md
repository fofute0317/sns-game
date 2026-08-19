# 通信仕様（引き継ぎ用）

拡張・保守を担当する開発者向けのメモです。

---

## 全体像

```
ブラウザ                          Vercel Functions              Supabase
────────                          ────────────────              ────────
client/play.js                    app/api/**/route.ts
client/teacher.js                     │
    │                                 ├─ lib/api.ts       … トークンで本人確認
    ▼                                 ├─ lib/store.ts     … 楽観ロックつき保存 ──▶ rooms
lib/realtime.ts ──── HTTP POST ──▶    ├─ lib/game.ts      … 1ゲーム分の状態遷移      players
    │                                 ├─ lib/engine.ts    … 計算（純粋関数）        game_events
    │                                 └─ config/rules.*.json … 数値と文章
    │                                     │
    └──────── broadcast ◀────────────────┴──────────────────── Realtime
                「変わったよ」の合図だけ                        room:{roomCode}
```

**原則1**: ブラウザから来るのは「どの選択肢を選んだか」だけ。
金額・点数・順位はすべてサーバが計算し、ブラウザは配られた状態を描画するだけです。

**原則2**: Realtime には状態そのものを載せません。合図だけを配り、
各ブラウザが自分のトークンで `/api/rooms/state` を取りに来ます。
生徒ごとに見えてよい情報が違うためです（後述）。

> 📄 自前の Node.js + WebSocket サーバからの移行内容は [../MIGRATION.md](../MIGRATION.md) に記録しています。

---

## 認証（アカウントなし）

ログインはありません。**トークンだけ**で本人を判定します。

| 役割 | トークンの出どころ | 保存先 |
| --- | --- | --- |
| 先生 | ルーム作成時に発行（`rooms.teacher_id`） | sessionStorage + localStorage |
| 生徒 | 参加時に発行（`players.token`） | sessionStorage + localStorage |

- sessionStorage … タブ単位。更新・スリープ復帰で自動復帰する（教室での主なケース）
- localStorage … タブを閉じた場合の保険。「前回の続きから戻る」ボタン用

すべてのAPIは `{ code, token }` を受け取り、`lib/api.ts` の `viewerOf()` で
`{ role: 'teacher' | 'player', playerId }` を判定します。
**権限はサーバ側で必ず確認します。** 生徒が先生の操作を送っても実行されません。

---

## HTTP API

すべて JSON。応答は `Cache-Control: no-store` です。
失敗時は `{ "error": "日本語の説明", "code": "<エラーコード>" }` を返します。
`error` はそのまま生徒に見せてよい文言にしています。

### ルーム

| メソッド・パス | 送るもの | 返るもの |
| --- | --- | --- |
| `POST /api/rooms/create` | `{ ruleset?, options?: { maxPlayers, timerSec, demandMode, autoAdvance } }` | `{ roomCode, roomId, role:'teacher', token, rules, strategies, state }` |
| `POST /api/rooms/join` | `{ code, name }` | `{ role:'player', playerId, token, rules, state }` |
| `POST /api/rooms/resume` | `{ code, token }` | `{ role, playerId, token, rules, state }` |
| `GET /api/rooms/state` | `?code=&token=` | `{ version, state }` |
| `GET /api/rooms/exists` | `?code=` | `{ exists, joinable, phase }` |

`ruleset` は `config/rules.<id>.json` の `<id>` かファイル名。既定は `mvp`。

### ゲーム進行

| メソッド・パス | 送るもの | 権限 |
| --- | --- | --- |
| `POST /api/game/start` | `{ code, token }` | 先生 |
| `POST /api/game/submit` | `{ code, token, decision }` | 生徒 |
| `POST /api/game/tick` | `{ code, token }` | どちらでも |
| `POST /api/game/update` | `{ code, token, action, ... }` | action ごと |

`/api/game/update` の `action`:

| `action` | 追加パラメータ | 権限 | 内容 |
| --- | --- | --- | --- |
| `draft` | `{ decision }` | 生徒 | 途中の選択を保存（部分指定可）。配信はしない |
| `unsubmit` | | 生徒 | 決定を取り消す（締め切り前のみ） |
| `leave` | | 生徒 | 退出する |
| `forceResolve` | | 先生 | 締め切って結果を出す。未提出者はその時点の選択で計算（`auto: true`） |
| `next` | | 先生 | 次へ（結果→次ラウンド、最終ラウンド→結果発表、発表の段階送り） |
| `back` | | 先生 | 結果発表の段階を1つ戻す |
| `addBot` | `{ strategy? }` | 先生 | 練習用AIを追加 |
| `removePlayer` | `{ playerId }` | 先生 | 生徒を退出させる |
| `restart` | | 先生 | 同じメンバーで最初から（点数リセット・イベント引き直し） |
| `setOptions` | `{ timerSec, autoAdvance }` | 先生 | 途中で設定を変える |
| `closeRoom` | | 先生 | ルームを終了 |

### その他

| パス | 内容 |
| --- | --- |
| `GET /api/rulesets` | ルールセットの一覧とAI戦略の一覧 |
| `GET /api/news` | トップページのお知らせ |
| `GET /api/health` | 死活確認（DBに実際につながるかを確認） |
| `GET /api/cron/sweep` | 放置ルームの後片付け（Vercel Cron が毎時。`CRON_SECRET` で保護可） |
| `GET /j/:code` | QR用の短縮URL → `/play?code=:code` へ302 |

### エラーコード

`noRoom` `cannotJoin` `noSession` `notInRoom` `forbidden` `badRequest`
`createFailed` `startFailed` `resolveFailed` `submitFailed` `nextFailed` `backFailed`
`noPlayer` `roomClosed` `conflict` `network` `config` `dbUnavailable` `internal`

`noSession` / `noRoom` / `roomClosed` を**再接続の途中**で受けた場合だけ、
クライアントはセッションを捨てて参加画面へ戻します。
参加操作そのものが失敗したときは、理由を画面に出したまま留まります
（ルーム番号の打ち間違いが教室でいちばん多い操作ミスなので、必ず理由を見せる）。

---

## Realtime

- チャンネル名: `room:{roomCode}`（`lib/realtime.ts` の `channelFor()`）
- 方式: Supabase Realtime の **broadcast**（Postgres Changes は使いません）
- サーバからの送信は HTTP エンドポイント `POST /realtime/v1/api/broadcast`
  （サーバレス関数で WebSocket を張らないため）

### イベント

| イベント名 | いつ流れるか |
| --- | --- |
| `PLAYER_JOINED` | 生徒が参加・再接続、AIを追加 |
| `PLAYER_LEFT` | 生徒が自分で退出 |
| `PLAYER_KICKED` | 先生が退出させた（`payload.playerId` が自分なら参加画面へ） |
| `GAME_STARTED` | ゲーム開始 |
| `ROUND_UPDATED` | ラウンドの解決・次ラウンドへ・やり直し |
| `ANSWER_SUBMITTED` | 決定の提出・取り消し |
| `SCORE_UPDATED` | 得点が更新された（ラウンド解決時） |
| `GAME_FINISHED` | 最終画面へ・段階の送り戻し |
| `ROOM_CLOSED` | ルーム終了（全員が終了画面へ） |
| `STATE_CHANGED` | 上記に当てはまらない変更 |

### payload

```jsonc
{ "roomCode": "482913", "version": 42, "at": 1755600000000, /* イベント固有の情報 */ }
```

**状態そのものは入りません。** 受け取ったブラウザは
`GET /api/rooms/state?code=&token=` で自分用のスナップショットを取りに行きます。

- 60msのあいだに来た合図は、まとめて1回の取得にします
- 4秒ごとのポーリングを常に併走させています
  → Realtime が遮断された環境（学校のプロキシなど）でも授業が成立します

### なぜ状態を配らないのか

決定フェーズ中、他人がどの選択肢を選んだかは見えてはいけません。
全員に同じ本文を配ると、ブラウザの開発者ツールから他人の選択が読めてしまいます。
往復が1回増えますが、実測で数十ミリ秒です。

---

## state（スナップショット）の主な中身

`welcome` 相当の応答と `/api/rooms/state` が返します。**常に全体で、差分ではありません。**

```jsonc
{
  "code": "482913",
  "phase": "lobby" | "decision" | "result" | "final",
  "round": 3, "totalRounds": 5,
  "finalStage": "profit" | "total" | "reflect",
  "deadline": 1755600000000,          // 制限時間つきのときだけ（ミリ秒）
  "event": { "id", "name", "icon", "headline", "body", "learn" },  // decision/result のとき
  "players": [
    { "id", "name", "company", "color", "icon",
      "connected", "isBot", "submitted", "funds", "producer", "society" }
  ],
  "submittedCount": 3, "playerCount": 4,
  "rounds": [                       // 解決済みラウンドの記録
    { "round": 1, "eventId": "quiet", "closedBy": "all" | "teacher" | "time",
      "results": [
        { "playerId", "decision", "auto",
          "quantity", "unitPrice", "unitCost",
          "revenue", "materialCost", "adCost", "giveCost", "profit",
          "producerGain", "societyGain",
          "factors": { "price", "ad", "ethical", "event", "luck" } }
      ] }
  ],
  "standings": { "profit": [...], "producer": [...], "society": [...], "total": [...] },
  "insights": [ { "type", "text", "ask" } ],   // 最終画面での話題づくり
  "you": {                                     // 生徒にだけ入る
    "id", "name", "company", "score", "draft", "submitted", "requiredKeys"
  }
}
```

**他人が何を選んだかは、ラウンドが解決するまで配られません。**

`rules` は参加・作成・再接続の応答に1度だけ入ります。画面はこれを見て選択肢を描画するので、
**config を変えれば画面も自動的に変わります**（コード変更不要）。

---

## 進行（phase）

```
lobby ──start──▶ decision ──全員提出 or forceResolve or 時間切れ──▶ result
                    ▲                                              │
                    └──────────── next（次の年へ）──────────────────┘
                                                                   │ 最終ラウンドなら
                                                                   ▼
                                    final: profit ──next──▶ total ──next──▶ reflect
                                              ◀──back──          ◀──back──
```

---

## 同時更新の扱い（サーバレス特有）

5人の生徒が同時に「決定する」を押すと、Vercel Functions が5つ同時に起動します。
素朴に「読んで→書く」と最後の1件以外が消えるため、`rooms.version` で楽観ロックします。

```sql
UPDATE rooms SET game_state = ..., version = version + 1
 WHERE id = ? AND version = ?;
```

0件更新なら競合なので、`lib/store.ts` の `mutateRoom()` が読み直してやり直します（最大6回）。
`lib/game.ts` が純粋関数なので、やり直しても副作用はありません。
配信・ログ・`players` テーブルの更新は、保存が成功したあとにだけ行います。

`mutateRoom()` は**どの操作よりも先に** `tickDeadline()` を通します。
これがサーバ側 `setTimeout` の代わりです。

---

## 計算の流れ（`lib/engine.ts`）

```
販売数 = 基準 × (1+価格の影響) × (1+広告の影響) × (1+原料の評判)
              × Π(イベントの倍率) × (1 ± 運)

売上     = 販売価格 × 販売数
原料費   = (カカオ単価 + 砂糖単価) × 販売数        ※単価はイベントで変動
利益     = 売上 − 原料費 − 広告費 − 追加還元
資金    += 利益

生産者点 += カカオ.producer + 砂糖.producer + 還元.producer
社会点   += カカオ.society  + 砂糖.society  + 還元.society

総合得点 = 0.6×正規化(資金) + 0.25×正規化(生産者点) + 0.15×正規化(社会点)
           （正規化はルーム内の最小〜最大を 0〜100 に変換）
```

乱数は **シード固定**（`rngFor(seed, 'r', roundIndex, playerId)`）。
同じ入力からは必ず同じ結果になるので、
**提出がどの順番で届いても結果は変わりません**（サーバレスでは到着順が毎回ちがいます）。
テストとバランス検証も再現可能です。`Math.random()` はゲーム計算で使いません。

---

## データベース

`supabase/schema.sql` を参照してください。要点だけ:

| テーブル | 役割 |
| --- | --- |
| `rooms` | **唯一の正**。`game_state` (JSONB) にゲーム状態のすべてが入る |
| `players` | 集計・分析用の写し。ゲーム進行は読まない |
| `game_events` | Realtime で流したイベントの記録 |

RLS を全テーブルで有効にし、ポリシーを1つも作っていません
（＝anon キーではテーブルに一切アクセスできない）。
読み書きはすべて service_role キーを持つ Vercel Functions が行います。

---

## 拡張するときの注意

- **数値を足したいだけなら `config/*.json` だけ**。`lib/rules.ts` の `validateRules()` が
  書式を検証し、誤りがあれば `npm test` と `npm run build` が失敗します
- ルールセットを**新しく追加**したときは、`lib/rules.ts` の `RAW_RULESETS` に1行足してください
  （Vercel ではファイル一覧を実行時に読めないため、ここだけ明示が必要です）
- 新しい決定項目を足すときは `kind` を `material` / `price` / `cost` から選びます。
  画面は `rules.decisions` を読んで自動生成されるので、UIの改修は不要です
- 新しいイベント効果を足すときは `lib/engine.ts` の `matchesWhen()` と
  `unitCostWithEvent()` に条件を追加し、`validateRules()` の許可リストも更新してください
- `RoomState`（`lib/types.ts`）に項目を増やすときは、**JSONにできる値だけ**にしてください。
  そのまま `rooms.game_state` に保存されます。`Map` / `Set` / 関数 / タイマーは入れられません
- 新しい操作を足すときは `/api/game/update` の `action` に追加します。
  楽観ロックの手続きを書き直さずに済みます
