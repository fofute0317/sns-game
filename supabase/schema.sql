-- ==================================================================
--  フェアトレード・チャレンジ ／ Supabase スキーマ
--
--  Supabase ダッシュボード > SQL Editor に貼り付けて実行してください。
--  （何度実行しても壊れないように書いてあります）
--
--  設計の要点
--  ------------------------------------------------------------------
--  1. ゲームの「正」は rooms.game_state (JSONB) 1行にまとまっています。
--     旧 server/room.js の Room.toJSON() をそのまま入れる形です。
--     1行に閉じているので、サーバレス環境でもトランザクションなしで
--     楽観ロック（version列のCAS）だけで整合性を保てます。
--
--  2. players / game_events は、その1行から派生した「読み取り用の写し」です。
--     集計・分析・授業後のふりかえりのために SQL で引けるようにしています。
--     ゲーム進行はこれらを読みません（＝ズレても進行は壊れません）。
--
--  3. RLS は全テーブルで有効、ポリシーは作りません。
--     ＝ anon キーではテーブルに一切アクセスできません。
--     読み書きはすべて Vercel Functions が service_role キーで行います。
--     ブラウザは Realtime の broadcast チャンネルだけを使います。
-- ==================================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------
-- rooms : 1ルーム = 1回の授業 = 1ゲーム
-- ------------------------------------------------------------------
create table if not exists public.rooms (
  id            uuid primary key default gen_random_uuid(),
  room_code     text        not null unique,
  teacher_id    text        not null,               -- 先生用トークン（匿名認証の代わり）
  status        text        not null default 'lobby',  -- lobby | decision | result | final | closed
  current_round integer     not null default 0,
  game_state    jsonb       not null,               -- ゲーム状態の全体（唯一の正）
  version       integer     not null default 1,     -- 楽観ロック用
  rule_id       text        not null default 'mvp',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint rooms_room_code_format check (room_code ~ '^[0-9]{6}$'),
  constraint rooms_status_valid
    check (status in ('lobby', 'decision', 'result', 'final', 'closed'))
);

create index if not exists rooms_room_code_idx  on public.rooms (room_code);
create index if not exists rooms_updated_at_idx on public.rooms (updated_at);
create index if not exists rooms_status_idx     on public.rooms (status);

-- ------------------------------------------------------------------
-- players : 参加者（生徒 + 練習用AI）
--   player_id は game_state 内のIDと同じ（例: p1_Kd8fQz）
-- ------------------------------------------------------------------
create table if not exists public.players (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid        not null references public.rooms (id) on delete cascade,
  player_id       text        not null,
  nickname        text        not null,
  company         text        not null default '',
  color           text        not null default '',
  icon            text        not null default '',
  token           text        not null,             -- 再入室用（ブラウザに保存される）
  is_bot          boolean     not null default false,
  bot_strategy    text,
  score           integer     not null default 0,   -- 会社の資金（円）
  producer_points integer     not null default 0,
  society_points  integer     not null default 0,
  submitted       boolean     not null default false,
  connected       boolean     not null default false,
  joined_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (room_id, player_id)
);

create index if not exists players_room_id_idx on public.players (room_id);
create index if not exists players_token_idx   on public.players (token);

-- ------------------------------------------------------------------
-- game_events : 進行ログ（Realtime で流したイベントの記録）
--   授業後のふりかえり・不具合調査・分析に使います。
-- ------------------------------------------------------------------
create table if not exists public.game_events (
  id         bigserial   primary key,
  room_id    uuid        not null references public.rooms (id) on delete cascade,
  event_type text        not null,
  payload    jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists game_events_room_id_idx    on public.game_events (room_id, id desc);
create index if not exists game_events_created_at_idx on public.game_events (created_at);

-- ------------------------------------------------------------------
-- updated_at の自動更新
-- ------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rooms_touch_updated_at on public.rooms;
create trigger rooms_touch_updated_at
  before update on public.rooms
  for each row execute function public.touch_updated_at();

drop trigger if exists players_touch_updated_at on public.players;
create trigger players_touch_updated_at
  before update on public.players
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------
-- 後片付け : 6時間さわられていないルームを消す
--   /api/cron/sweep（Vercel Cron・毎時）から呼ばれます。
-- ------------------------------------------------------------------
create or replace function public.cleanup_stale_rooms(max_idle_hours integer default 6)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with gone as (
    delete from public.rooms
     where updated_at < now() - make_interval(hours => max_idle_hours)
    returning 1
  )
  select count(*) into removed from gone;
  return removed;
end;
$$;

-- ------------------------------------------------------------------
-- RLS : anon からは一切触れないようにする（ポリシーを作らない = 全拒否）
--   service_role キーは RLS をバイパスするため、API 側は通常どおり動きます。
-- ------------------------------------------------------------------
alter table public.rooms       enable row level security;
alter table public.players     enable row level security;
alter table public.game_events enable row level security;

revoke all on public.rooms       from anon, authenticated;
revoke all on public.players     from anon, authenticated;
revoke all on public.game_events from anon, authenticated;
