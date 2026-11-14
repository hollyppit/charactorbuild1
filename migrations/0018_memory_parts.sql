-- 0018_memory_parts.sql  (5단계 두 번째 게임 "기억 조각 그림")
-- 선행: 0016(game_rooms, gm_start), 0017(gm_housekeeping 갱신본), char_items(category='character' 기본 캐릭터)
-- 진행(라운드마다): 맞히는 사람 1명(순서대로 돌아가며), 나머지는 그리는 사람.
--   show(4초: 그리는 사람만 캐릭터를 3초 봄) → draw(60초: 각자 맡은 부위 띠만 그림) → guess(20초: 맞히는 사람이 합친 그림을 보고
--   캐릭터 그림 4개 중 고르기) → result(6초: 정답 공개) → 다음 라운드. 라운드 수 = 참가자 수(2~5).
-- 부위: 그리는 사람 K명(1~4)이 그림을 위에서 아래로 K칸으로 나눠 맡음. 라운드마다 맡는 칸이 바뀜.
-- 점수: 맞히면 맞힌 사람 +2, 그 라운드에 부위를 낸 사람마다 +1. 그림은 끝나고 1일 뒤 삭제.

begin;

insert into public.games (key, title, status, min_players, max_players, sort)
values ('memory_parts', '기억 조각 그림', 'beta', 2, 5, 2) on conflict (key) do nothing;

create table if not exists public.mp_rounds (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  round       int not null check (round between 0 and 7),
  guesser_id  uuid references public.profiles(id) on delete set null,
  char_id     text not null,
  options     text[] not null,            -- 캐릭터 id 4개(정답 포함, 섞음)
  guess_id    text,
  correct     boolean,
  primary key (room_id, round)
);
create table if not exists public.mp_parts (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  round       int not null check (round between 0 and 7),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  part        int not null check (part between 0 and 3),
  image       text check (image is null or char_length(image) <= 200000),
  created_at  timestamptz not null default now(),
  primary key (room_id, round, user_id)
);
alter table public.mp_rounds enable row level security;
alter table public.mp_parts  enable row level security;
revoke all on public.mp_rounds, public.mp_parts from anon, authenticated;

-- 라운드 하나 준비 (캐릭터·보기 고르기, show 단계로)
create or replace function public.mp_new_round(p_room uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; n int; v_char text; v_opts text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality t(x, o);
  n := array_length(v_order, 1);
  select id into v_char from public.char_items
   where category = 'character' and coalesce(src, '') <> ''
     and id not in (select char_id from public.mp_rounds where room_id = p_room)
   order by random() limit 1;
  if v_char is null then select id into v_char from public.char_items where category = 'character' and coalesce(src, '') <> '' order by random() limit 1; end if;
  select array_agg(x order by random()) into v_opts from (
    select v_char as x union all
    (select id from public.char_items where category = 'character' and coalesce(src, '') <> '' and id <> v_char order by random() limit 3)) t;
  insert into public.mp_rounds (room_id, round, guesser_id, char_id, options)
  values (p_room, p_round, v_order[(p_round % n) + 1], v_char, v_opts)
  on conflict (room_id, round) do update set guesser_id = excluded.guesser_id, char_id = excluded.char_id, options = excluded.options, guess_id = null, correct = null;
  delete from public.mp_parts where room_id = p_room and round = p_round;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'show', 'round', p_round, 'deadline', now() + interval '4 seconds'),
         version = version + 1, updated_at = now() where id = p_room;
end $$;

-- 시작 (방장)
create or replace function public.mp_start(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; n int; res jsonb;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'memory_parts' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  if (select count(*) from public.char_items where category = 'character' and coalesce(src, '') <> '') < 4 then
    return jsonb_build_object('ok', false, 'error', 'try_again');
  end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by random()) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  n := array_length(v_order, 1);
  delete from public.mp_rounds where room_id = p_room;
  update public.game_rooms set state = jsonb_build_object('game', 'memory_parts', 'phase', 'show', 'round', 0, 'rounds', n,
      'order', to_jsonb(v_order), 'draw_sec', 60, 'guess_sec', 20, 'result_sec', 6, 'deadline', now() + interval '4 seconds')
   where id = p_room;
  perform public.mp_new_round(p_room, 0);
  return jsonb_build_object('ok', true);
end $$;

-- 다음 단계로 (마감이 지났거나 할 일이 다 끝났을 때만)
create or replace function public.mp_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; ph text; rd int; v_order uuid[]; mr public.mp_rounds; v_need int; v_done int; v_due boolean;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'memory_parts' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; ph := st->>'phase'; rd := (st->>'round')::int;
  v_due := now() >= (st->>'deadline')::timestamptz;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  select * into mr from public.mp_rounds where room_id = p_room and round = rd;
  if ph = 'show' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'draw', 'deadline', now() + make_interval(secs => (st->>'draw_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'draw');
  end if;
  if ph = 'draw' then
    select count(*) into v_need from public.game_room_members where room_id = p_room and left_at is null and user_id = any(v_order) and user_id is distinct from mr.guesser_id;
    select count(*) into v_done from public.mp_parts p join public.game_room_members m on m.room_id = p.room_id and m.user_id = p.user_id and m.left_at is null
     where p.room_id = p_room and p.round = rd;
    if v_done < v_need and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    -- 맞히는 사람이 방을 나갔으면 맞히기를 건너뜀
    if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = mr.guesser_id and left_at is null) then
      update public.mp_rounds set correct = false where room_id = p_room and round = rd;
      update public.game_rooms set state = st || jsonb_build_object('phase', 'result', 'deadline', now() + make_interval(secs => (st->>'result_sec')::int)),
             version = version + 1, updated_at = now() where id = p_room;
      return jsonb_build_object('ok', true, 'phase', 'result');
    end if;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'guess', 'deadline', now() + make_interval(secs => (st->>'guess_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'guess');
  end if;
  if ph = 'guess' then
    if mr.guess_id is null and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.mp_rounds set correct = (guess_id is not null and guess_id = char_id) where room_id = p_room and round = rd;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'result', 'deadline', now() + make_interval(secs => (st->>'result_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'result');
  end if;
  if ph = 'result' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    if rd + 1 < (st->>'rounds')::int then
      perform public.mp_new_round(p_room, rd + 1);
      return jsonb_build_object('ok', true, 'round', rd + 1);
    end if;
    -- 끝: 점수 계산
    with sc as (
      select u.uid,
             coalesce((select sum(2) from public.mp_rounds x where x.room_id = p_room and x.guesser_id = u.uid and x.correct), 0)
           + coalesce((select count(*) from public.mp_parts p join public.mp_rounds x on x.room_id = p.room_id and x.round = p.round
                        where p.room_id = p_room and p.user_id = u.uid and p.image is not null and x.correct), 0) as score
        from unnest(v_order) as u(uid)
    )
    insert into public.game_results (room_id, user_id, rank, score)
    select p_room, sc.uid, dense_rank() over (order by sc.score desc), sc.score from sc
     where exists (select 1 from public.profiles where id = sc.uid)
    on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
    update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal'),
           version = version + 1, updated_at = now() where id = p_room;
    update public.game_room_members set ready = false where room_id = p_room;
    return jsonb_build_object('ok', true, 'ended', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'not_playing');
end $$;

-- 내기: 그리는 사람은 draw 단계에 부위 그림, 맞히는 사람은 guess 단계에 보기 하나
create or replace function public.mp_submit(p_user uuid, p_room uuid, p_round int, p_image text, p_choice text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; rd int; mr public.mp_rounds; v_order uuid[]; v_drawers uuid[]; k int; g int; idx int;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'memory_parts' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; rd := (st->>'round')::int;
  if p_round is distinct from rd then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select * into mr from public.mp_rounds where room_id = p_room and round = rd;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality t(x, o);
  if not (p_user = any(v_order)) then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
  if st->>'phase' = 'draw' then
    if p_user = mr.guesser_id then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
    if p_image is null or char_length(p_image) > 200000 or p_image !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_image');
    end if;
    -- 맡은 칸: 그리는 사람 순서(순서표에서 맞히는 사람 뺀 것)와 라운드로 정함
    select array_agg(x order by o) into v_drawers from unnest(v_order) with ordinality t(x, o) where x is distinct from mr.guesser_id;
    k := array_length(v_drawers, 1);
    select (o - 1)::int into idx from unnest(v_drawers) with ordinality t(x, o) where x = p_user;
    g := (idx + rd) % least(k, 4);
    insert into public.mp_parts (room_id, round, user_id, part, image) values (p_room, rd, p_user, g, p_image)
    on conflict (room_id, round, user_id) do update set image = excluded.image, created_at = now();
  elsif st->>'phase' = 'guess' then
    if p_user is distinct from mr.guesser_id then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
    if mr.guess_id is not null then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
    if p_choice is null or not (p_choice = any(mr.options)) then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
    update public.mp_rounds set guess_id = p_choice where room_id = p_room and round = rd;
  else
    return jsonb_build_object('ok', false, 'error', 'step_over');
  end if;
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  perform public.mp_advance(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- 정리: 끝난 지 1일 지난 방의 릴레이·기억 조각 그림 지우기 (나머지는 0017 과 같음)
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int;
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
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d + e);
end $$;

do $$ declare f text; begin
  foreach f in array array['mp_new_round(uuid, int)', 'mp_start(uuid, uuid)', 'mp_advance(uuid)', 'mp_submit(uuid, uuid, int, text, text)', 'gm_housekeeping()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
