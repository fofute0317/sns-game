# セットアップとデプロイ手順

はじめての方でも 15〜20分で公開できます。順番どおりに進めてください。

- [1. Supabase の準備](#1-supabase-の準備)
- [2. 環境変数](#2-環境変数)
- [3. ローカルで動かす](#3-ローカルで動かす)
- [4. Vercel へデプロイ](#4-vercel-へデプロイ)
- [5. 授業前の動作確認](#5-授業前の動作確認)
- [6. 困ったとき](#6-困ったとき)

---

## 1. Supabase の準備

### 1-1. プロジェクトを作る

1. <https://supabase.com> にログインし、**New project** を押す
2. 入力する項目
   - **Name**: `fairtrade-challenge`（何でも構いません）
   - **Database Password**: 自動生成のままでOK（この先使いません）
   - **Region**: 日本の学校で使うなら **Northeast Asia (Tokyo)** を選ぶ
     → 生徒の端末からの反応が速くなります
3. 作成完了まで1〜2分待ちます

### 1-2. テーブルを作る

1. 左メニューの **SQL Editor** を開く
2. **New query** を押す
3. このリポジトリの [`supabase/schema.sql`](supabase/schema.sql) の中身を**すべて**貼り付ける
4. **Run** を押す

`Success. No rows returned` と出れば完了です。
何度実行しても壊れないように書いてあるので、やり直しても問題ありません。

左メニューの **Table Editor** に `rooms` / `players` / `game_events` の3つが
できていることを確認してください。

### 1-3. Realtime を確認する

このアプリは Realtime の **broadcast** 機能だけを使います。
Supabase の新規プロジェクトでは既定で有効なので、通常は設定不要です。

（もし念のため確認したい場合は、左メニュー **Database → Replication** ではなく、
**Project Settings → API → Realtime** が Enabled になっていれば大丈夫です）

### 1-4. キーを控える

左メニューの **Project Settings → API** を開き、次の3つを控えます。

| 画面上の名前 | 環境変数名 | 公開してよいか |
| --- | --- | --- |
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` | ブラウザに渡ります |
| `anon` `public` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ブラウザに渡ります |
| `service_role` `secret` | `SUPABASE_SERVICE_ROLE_KEY` | **絶対に公開しない** |

> **service_role キーについて**
> このキーはデータベースの全権限を持ちます。サーバ（Vercel Functions）だけで使い、
> GitHub にコミットしたり、ブラウザ側のコードから読んだりしないでください。
> `NEXT_PUBLIC_` を**付けない**ことが安全のかなめです。
>
> anon キーが漏れても被害はありません。`supabase/schema.sql` で
> RLS（行レベルセキュリティ）を有効にし、ポリシーを1つも作っていないため、
> anon キーではテーブルに一切アクセスできないからです。

---

## 2. 環境変数

必要なのは3つ（＋任意で1つ）です。

| 変数名 | 必須 | 用途 |
| --- | :---: | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | ● | Supabase プロジェクトのURL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ● | ブラウザからの Realtime 購読 |
| `SUPABASE_SERVICE_ROLE_KEY` | ● | サーバからのDB読み書き |
| `CRON_SECRET` | | `/api/cron/sweep` を外部から叩かれないようにする |

雛形は [`.env.example`](.env.example) にあります。

---

## 3. ローカルで動かす

```bash
# 1. 依存パッケージを入れる
npm install

# 2. 環境変数ファイルを作る
cp .env.example .env.local
#    → .env.local を開き、1-4 で控えた3つの値を貼り付ける

# 3. 開発サーバを起動
npm run dev
```

ブラウザで開きます。

| 画面 | URL |
| --- | --- |
| トップページ | <http://localhost:3000/> |
| 先生用コンソール | <http://localhost:3000/teacher> |
| 生徒用 | <http://localhost:3000/play> |

**同じWi-Fi内の端末（タブレットなど）から試したいとき**

```bash
npm run dev -- -H 0.0.0.0
```

PC の IP アドレス（`ipconfig` / `ifconfig` で確認）を使って
`http://192.168.x.x:3000/play` のように開きます。

### 本番と同じ形で確認する

```bash
npm run build   # 本番ビルド（型チェックも走ります）
npm run start   # 本番モードで起動
```

---

## 4. Vercel へデプロイ

### 4-1. GitHub に上げる

```bash
git add -A
git commit -m "feat: Vercel + Supabase 構成へ移行"
git push
```

> `.env.local` は `.gitignore` に入っているため、キーが push されることはありません。

### 4-2. Vercel にインポート

1. <https://vercel.com/new> を開く
2. リポジトリを選んで **Import**
3. Framework Preset に **Next.js** が自動で入ることを確認
   （Build Command / Output Directory は既定のままでOK）

### 4-3. 環境変数を登録する

**Deploy を押す前に**、**Environment Variables** に3つを登録します。

| Key | Value | Environment |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxxx.supabase.co` | Production, Preview, Development |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbG...` | Production, Preview, Development |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbG...` | Production, Preview, Development |

`CRON_SECRET` を使う場合は、適当な長い文字列を作って同様に登録します
（例: `openssl rand -hex 32`）。

### 4-4. Deploy

**Deploy** を押します。2〜3分でURLが発行されます。

```
https://fairtrade-challenge.vercel.app/
```

### 4-5. リージョンについて

[`vercel.json`](vercel.json) で `"regions": ["hnd1"]`（東京）を指定しています。
日本以外で使う場合は、Supabase のリージョンに近い値へ変更してください。
関数とデータベースが遠いと、1操作ごとの往復が増えて反応が鈍くなります。

### 4-6. あとから環境変数を変えたとき

Vercel は環境変数を**ビルド時に埋め込みます**（`NEXT_PUBLIC_` のものは特に）。
値を変えたら、必ず **Redeploy** してください。

---

## 5. 授業前の動作確認

### 5-1. まず死活確認

<https://あなたのURL/api/health> を開きます。

```json
{ "ok": true, "rooms": 0, "db": "connected", "latencyMs": 42 }
```

`"ok": false` のときは [6. 困ったとき](#6-困ったとき) を見てください。

### 5-2. 先生の流れ

1. `/teacher` を開く
2. ルールセット（中学・高校版／小学校版）、人数、制限時間を選ぶ
3. **ルームを作成** を押す
4. **6桁のルーム番号**とQRコードが表示される ✔

### 5-3. 生徒の流れ

1. 別のタブ（できれば別の端末）で `/play` を開く
2. ルーム番号と名前を入れて **参加する**
3. 会社（レッドカカオ社など）が割り当てられ、待機画面になる ✔
4. 先生の画面に、その生徒が**すぐに**現れる ✔

QRコードを読み取ると `/j/123456` → `/play?code=123456` へ転送され、
番号が入力済みの状態で開きます。

### 5-4. リアルタイムの確認

先生の画面と生徒の画面を**並べて**表示し、次を確認します。

| 先生の操作 | 生徒の画面 |
| --- | --- |
| ゲームを開始 | すぐに決定画面へ切り替わる |
| 締め切る | すぐに結果画面へ切り替わる |
| 次へ | すぐに次のラウンドへ |
| 生徒を退出させる | その生徒だけ参加画面に戻る |
| ルームを終了 | 全員に終了メッセージ |

| 生徒の操作 | 先生の画面 |
| --- | --- |
| 参加する | 参加者一覧に追加される |
| 決定する | 「◯/◯人が決定ずみ」が増える |

### 5-5. 5人以上での確認

1台のPCだけで確認できます。

- **方法A（おすすめ）**: 先生画面の **🤖 AIを追加** を人数分押す
- **方法B**: ブラウザのタブを5つ開き、それぞれ `/play` から別の名前で参加する
  （※ 同じブラウザの**通常タブ**なら別々の生徒として扱われます）

6人が参加した状態で1ラウンド回し、全員の結果が同じ順位・同じ金額で
表示されることを確認してください。

### 5-6. 再接続の確認

生徒の画面で **F5（再読み込み）** を押します。
同じ会社のまま、同じ画面に戻れば成功です（トークンで自動復帰します）。

---

## 6. 困ったとき

### `/api/health` が `"ok": false` になる

| `message` の内容 | 原因と対処 |
| --- | --- |
| `環境変数 ... が設定されていません` | Vercel の Environment Variables を確認し、**Redeploy** する |
| `fetch failed` / `ENOTFOUND` | `NEXT_PUBLIC_SUPABASE_URL` の打ち間違い。末尾に `/` を付けない |
| `Invalid API key` | キーの貼り間違い。`service_role` と `anon` を取り違えていないか確認 |
| `relation "public.rooms" does not exist` | `supabase/schema.sql` を実行していない（手順1-2） |

### ルームは作れるが、生徒の画面が更新されない

Realtime が届いていない可能性があります。まず切り分けます。

- **4秒ほど待つと更新される** → Realtime が不通。保険のポーリングで動いています。
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` が正しいか、
  学校のネットワークが WebSocket を遮断していないかを確認してください。
- **まったく更新されない** → ブラウザの開発者ツール（F12）のコンソールを確認してください。

> ポーリングは常時併走しているため、**Realtime が完全に遮断された環境でも授業は成立します**
> （反応が最大4秒遅れます）。

### 「ほかの操作と重なりました」と出る

同時更新のやり直しが6回とも失敗した場合に出ます。
通常の授業（〜8人）ではまず起きません。頻発する場合は
`lib/store.ts` の `MAX_RETRIES` を増やしてください。

### ルームが増えすぎないか心配

Vercel Cron が毎日 `/api/cron/sweep` を叩き、
**6時間さわられていないルーム**を自動削除します。
参加者・進行ログも一緒に消えます（外部キーの ON DELETE CASCADE）。

手動で消したいときは、Supabase の SQL Editor で:

```sql
select public.cleanup_stale_rooms(6);   -- 6時間以上放置されたルームを削除
delete from public.rooms where room_code = '123456';  -- 特定のルームを削除
```

### 授業のあとで結果を見返したい

```sql
-- ルーム一覧
select room_code, status, current_round, created_at
  from rooms order by created_at desc limit 20;

-- あるルームの最終成績
select nickname, company, score, producer_points, society_points
  from players
  join rooms on rooms.id = players.room_id
 where rooms.room_code = '123456'
 order by score desc;

-- 進行ログ
select event_type, payload, created_at
  from game_events
  join rooms on rooms.id = game_events.room_id
 where rooms.room_code = '123456'
 order by game_events.id;
```

先生用コンソールの **CSV出力** ボタンでも、全ラウンドの記録を書き出せます。

---

## 7. 無料プランで足りるか

| | Supabase Free | この教材の使い方 |
| --- | --- | --- |
| データベース | 500MB | 1ルーム約50KB。1万ルームでも足りる |
| Realtime 同時接続 | 200 | 1ルーム最大9接続（先生1＋生徒8） |
| Realtime メッセージ | 200万/月 | 1授業あたり数百件 |
| API リクエスト | 無制限 | — |

| | Vercel Hobby | この教材の使い方 |
| --- | --- | --- |
| 関数の実行 | 100GB-時間/月 | 1操作あたり100ms程度 |
| 帯域 | 100GB/月 | 1回の授業で数MB |
| Cron | 1日1回まで | `vercel.json` は毎日3時。そのままで動きます |

> **Cron の頻度について**
> `vercel.json` の Cron は **毎日3時**（`0 3 * * *`）にしています。
> Hobby プランは1日1回までなので、この設定ならどのプランでもそのまま動きます。
> Pro 以上で毎時にしたい場合は `"0 * * * *"` に変えてください。
>
> なお、放置ルームが残っていても授業には影響しません（参加は番号を知っている人だけ）。

> **7日間の一時停止について**
> Supabase の無料プロジェクトは、7日間アクセスがないと自動的に一時停止します。
> 授業の前日に `/api/health` を一度開いておくと確実です。
