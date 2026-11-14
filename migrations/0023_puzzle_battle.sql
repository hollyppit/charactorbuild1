-- 0023_puzzle_battle.sql  (그림 퍼즐 친구 배틀)
-- 선행: 0016(game_rooms, gm_start), 0022(gm_housekeeping 갱신본), char_items(category='puzzle': label=제목, src=그림, src_back='hidden'이면 숨김)
-- 방장이 그림(또는 무작위)·난이도를 고르면 모두 같은 그림·같은 seed(같은 조각 모양·섞임)로 동시에 시작.
-- 각자 맞춘 조각 수를 보내고, 다 맞추면 걸린 시간 기록(조각 수 × 0.8초보다 빠르면 거절). 모두 완성하거나 제한 시간이 지나면 끝.
-- 순위: 완성한 사람(빠른 순) → 못 한 사람(맞춘 비율 높은 순). 조각 모양은 브라우저가 seed 로 만들고, 직소·사각 조각 중 각자 편한 방식으로 해도 됨.

begin;

insert into public.games (key, title, status, min_players, max_players, sort)
values ('jigsaw', '그림 퍼즐 배틀', 'beta', 2, 8, 6) on conflict (key) do nothing;

create table if not exists public.pz_games (
  room_id     uuid primary key references public.game_rooms(id) on delete cascade,
  item_id     text not null,
  title       text not null,
  image       text not null,
  level       text not null check (level in ('easy','normal','hard','expert','master')),
  seed        int not null,
  started_at  timestamptz not null default now()
);
create table if not exists public.pz_progress (
  room_id      uuid not null references public.game_rooms(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  placed       int not null default 0 check (placed between 0 and 300),
  total        int not null check (total between 4 and 300),
  finished_at  timestamptz,
  ms           int,
  updated_at   timestamptz not null default now(),
  primary key (room_id, user_id)
);
alter table public.pz_games    enable row level security;
alter table public.pz_progress enable row level security;
revoke all on public.pz_games, public.pz_progress from anon, authenticated;

-- 시작 (방장). p_item 이 없거나 쓸 수 없으면 무작위 그림
create or replace function public.pz_start(p_actor uuid, p_room uuid, p_level text, p_item text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; res jsonb; it record; lv text := case when p_level in ('easy','normal','hard','expert','master') then p_level else 'normal' end;
  lim int;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'jigsaw' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  select id, label, src into it from public.char_items
   where category = 'puzzle' and coalesce(src, '') <> '' and coalesce(src_back, '') <> 'hidden' and id = p_item;
  if it.id is null then
    select id, label, src into it from public.char_items
     where category = 'puzzle' and coalesce(src, '') <> '' and coalesce(src_back, '') <> 'hidden' order by random() limit 1;
  end if;
  if it.id is null then return jsonb_build_object('ok', false, 'error', 'no_puzzle'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by joined_at) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  lim := case lv when 'easy' then 240 when 'normal' then 360 when 'hard' then 600 when 'expert' then 900 else 1200 end;
  delete from public.pz_progress where room_id = p_room;
  insert into public.pz_games (room_id, item_id, title, image, level, seed) values (p_room, it.id, coalesce(nullif(it.label, ''), '그림'), it.src, lv, floor(random() * 2000000000)::int)
  on conflict (room_id) do update set item_id = excluded.item_id, title = excluded.title, image = excluded.image, level = excluded.level, seed = excluded.seed, started_at = now();
  update public.game_rooms set state = jsonb_build_object('game', 'jigsaw', 'phase', 'play', 'order', to_jsonb(v_order), 'limit_sec', lim,
      'deadline', now() + make_interval(secs => lim)),
    version = version + 1, updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true);
end $$;

-- 끝내기: 순위 기록 (완성한 사람 빠른 순 → 못 한 사람 맞춘 비율 순). score = 완성이면 남은 시간 포함 1000 + …, 아니면 맞춘 %(0~100)
create or replace function public.pz_finish(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  with sc as (
    select u.uid, p.finished_at is not null as fin, coalesce(p.ms, 0) as ms,
           case when p.total > 0 then floor(100.0 * p.placed / p.total) else 0 end as pct
      from unnest(v_order) as u(uid) left join public.pz_progress p on p.room_id = p_room and p.user_id = u.uid
  )
  insert into public.game_results (room_id, user_id, rank, score)
  select p_room, sc.uid, row_number() over (order by sc.fin desc, case when sc.fin then sc.ms end asc nulls last, sc.pct desc),
         case when sc.fin then 1000 + greatest(0, (st->>'limit_sec')::int - sc.ms / 1000) else sc.pct end
    from sc where exists (select 1 from public.profiles where id = sc.uid)
  on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
  update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal'),
         version = version + 1, updated_at = now() where id = p_room;
  update public.game_room_members set ready = false where room_id = p_room;
end $$;

create or replace function public.pz_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_need int; v_done int;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'jigsaw' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  select count(*) into v_need from public.game_room_members m where m.room_id = p_room and m.left_at is null
     and m.user_id in (select x::uuid from jsonb_array_elements_text(r.state->'order') x);
  select count(*) into v_done from public.pz_progress p join public.game_room_members m on m.room_id = p.room_id and m.user_id = p.user_id and m.left_at is null
   where p.room_id = p_room and p.finished_at is not null;
  if v_done < v_need and now() < (r.state->>'deadline')::timestamptz then return jsonb_build_object('ok', true, 'waiting', true); end if;
  perform public.pz_finish(p_room);
  return jsonb_build_object('ok', true, 'ended', true);
end $$;

-- 진행 보내기 (참가자). 다 맞추면 시간 기록, 너무 빠르면 거절
create or replace function public.pz_report(p_user uuid, p_room uuid, p_placed int, p_total int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; g public.pz_games; v_ms int; cur public.pz_progress;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'jigsaw' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null)
     or not exists (select 1 from jsonb_array_elements_text(r.state->'order') x where x::uuid = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_player');
  end if;
  if p_total is null or p_total < 4 or p_total > 300 or p_placed is null or p_placed < 0 or p_placed > p_total then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
  select * into cur from public.pz_progress where room_id = p_room and user_id = p_user;
  if cur.finished_at is not null then return jsonb_build_object('ok', true, 'finished', true); end if;
  select * into g from public.pz_games where room_id = p_room;
  v_ms := floor(extract(epoch from (now() - g.started_at)) * 1000)::int;
  if p_placed = p_total and v_ms < p_total * 800 then return jsonb_build_object('ok', false, 'error', 'too_fast'); end if;
  insert into public.pz_progress (room_id, user_id, placed, total, finished_at, ms, updated_at)
  values (p_room, p_user, p_placed, p_total, case when p_placed = p_total then now() end, case when p_placed = p_total then v_ms end, now())
  on conflict (room_id, user_id) do update set placed = excluded.placed, total = excluded.total, finished_at = excluded.finished_at, ms = excluded.ms, updated_at = now();
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  if p_placed = p_total then perform public.pz_advance(p_room); end if;
  return jsonb_build_object('ok', true, 'finished', p_placed = p_total);
end $$;

-- 정리: 끝난 지 1일 지난 퍼즐 배틀 기록 지우기 (나머지는 0022 와 같음)
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int; f int; g int;
begin
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'waiting' and expires_at < now();
  get diagnostics a = row_count;
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'playing' and started_at < now() - interval '6 hours';
  get diagnostics b = row_count;
  delete from public.gd_entries where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics d = row_count;
  delete from public.gd_chains where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.mp_parts where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics e = row_count;
  delete from public.mp_rounds where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qd_strokes where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics f = row_count;
  delete from public.qd_hits where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qd_turns where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qd_guess_meta where room_id in (
    select id from public.game_rooms where status in ('ended','closed'));
  delete from public.lr_draws where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics g = row_count;
  delete from public.lr_votes where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.lr_rounds where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qb_answers where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qb_questions where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.pz_progress where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.pz_games where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d + e + f + g);
end $$;

do $$ declare fn text; begin
  foreach fn in array array['pz_start(uuid, uuid, text, text)', 'pz_finish(uuid)', 'pz_advance(uuid)', 'pz_report(uuid, uuid, int, int)', 'gm_housekeeping()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

commit;
