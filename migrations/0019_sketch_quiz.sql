-- 0019_sketch_quiz.sql  (5단계 세 번째 게임 "쓱싹 퀴즈" — 한 명이 그리고 나머지가 맞히기)
-- 선행: 0016(game_rooms, gm_start), 0017(game_words), 0018(gm_housekeeping 갱신본)
-- 차례마다: pick(10초: 그리는 사람이 제시어 3개 중 고르기, 안 고르면 첫 번째) → draw(80초: 획을 조각으로 보내고,
--   다른 사람은 정답 입력) → turn_end(5초: 정답 공개) → 다음 차례. 차례 수 = 참가자 수 × 바퀴(1~2).
-- 점수: 맞힌 순서대로 10·8·6·5·4·3…점, 그린 사람은 맞힌 사람 1명당 +3. 틀린 답은 저장하지 않음(본인 화면에만).
-- 획·차례 기록은 끝나고 1일 뒤 삭제(점수·순위만 game_results 에 90일).

begin;

insert into public.games (key, title, status, min_players, max_players, sort)
values ('sketch_quiz', '쓱싹 퀴즈', 'beta', 2, 8, 3) on conflict (key) do nothing;

create table if not exists public.qd_turns (
  room_id       uuid not null references public.game_rooms(id) on delete cascade,
  turn          int not null check (turn between 0 and 15),
  drawer_id     uuid references public.profiles(id) on delete set null,
  choices       text[] not null,
  word          text,
  draw_started  timestamptz,
  primary key (room_id, turn)
);
create table if not exists public.qd_strokes (
  id          bigint generated always as identity primary key,
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  turn        int not null,
  data        jsonb not null check (char_length(data::text) <= 16000),
  created_at  timestamptz not null default now()
);
create index if not exists qd_strokes_room_turn on public.qd_strokes (room_id, turn, id);
create table if not exists public.qd_hits (
  room_id  uuid not null references public.game_rooms(id) on delete cascade,
  turn     int not null,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  points   int not null,
  at       timestamptz not null default now(),
  primary key (room_id, turn, user_id)
);
-- 정답 입력 간격 확인용 (마지막 입력 시각만)
create table if not exists public.qd_guess_meta (
  room_id  uuid not null references public.game_rooms(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  last_at  timestamptz not null,
  primary key (room_id, user_id)
);
alter table public.qd_turns      enable row level security;
alter table public.qd_strokes    enable row level security;
alter table public.qd_hits       enable row level security;
alter table public.qd_guess_meta enable row level security;
revoke all on public.qd_turns, public.qd_strokes, public.qd_hits, public.qd_guess_meta from anon, authenticated;

-- 띄어쓰기·대소문자 무시
create or replace function public.qd_norm(t text) returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(t, ''), '\s+', '', 'g'));
$$;
-- 한 글자만 다른지(바꾸기·빼기·더하기 하나) — "거의 맞았어요" 안내용
create or replace function public.qd_close(a text, b text) returns boolean language plpgsql immutable as $$
declare la int := char_length(a); lb int := char_length(b); i int; diff int := 0; s text; l text;
begin
  if a = b or abs(la - lb) > 1 or la = 0 or lb = 0 then return false; end if;
  if la = lb then
    for i in 1..la loop if substr(a, i, 1) <> substr(b, i, 1) then diff := diff + 1; end if; end loop;
    return diff = 1;
  end if;
  if la > lb then l := a; s := b; else l := b; s := a; end if;
  for i in 1..char_length(l) loop
    if substr(l, 1, i - 1) || substr(l, i + 1) = s then return true; end if;
  end loop;
  return false;
end $$;

-- 차례 하나 준비: 그리는 사람이 방에 없으면 다음 사람으로 넘김. 남은 차례가 없으면 false
create or replace function public.qd_new_turn(p_room uuid, p_turn int)
returns boolean language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; n int; t int; v_drawer uuid; v_choices text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality q(x, o);
  n := array_length(v_order, 1);
  t := p_turn;
  while t < (st->>'turns')::int loop
    v_drawer := v_order[(t % n) + 1];
    exit when exists (select 1 from public.game_room_members where room_id = p_room and user_id = v_drawer and left_at is null);
    t := t + 1;
  end loop;
  if t >= (st->>'turns')::int then return false; end if;
  select array_agg(word) into v_choices from (
    select word from public.game_words where active and word not in (select coalesce(word, '') from public.qd_turns where room_id = p_room)
     order by random() limit 3) w;
  insert into public.qd_turns (room_id, turn, drawer_id, choices) values (p_room, t, v_drawer, v_choices)
  on conflict (room_id, turn) do update set drawer_id = excluded.drawer_id, choices = excluded.choices, word = null, draw_started = null;
  delete from public.qd_strokes where room_id = p_room and turn = t;
  delete from public.qd_hits where room_id = p_room and turn = t;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'pick', 'turn', t, 'deadline', now() + make_interval(secs => (st->>'pick_sec')::int)),
         version = version + 1, updated_at = now() where id = p_room;
  return true;
end $$;

-- 끝: 점수 계산·결과 기록
create or replace function public.qd_finish(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  with sc as (
    select u.uid,
           coalesce((select sum(points) from public.qd_hits h where h.room_id = p_room and h.user_id = u.uid), 0)
         + coalesce((select count(*) * 3 from public.qd_hits h join public.qd_turns t on t.room_id = h.room_id and t.turn = h.turn
                      where h.room_id = p_room and t.drawer_id = u.uid), 0) as score
      from unnest(v_order) as u(uid)
  )
  insert into public.game_results (room_id, user_id, rank, score)
  select p_room, sc.uid, dense_rank() over (order by sc.score desc), sc.score from sc
   where exists (select 1 from public.profiles where id = sc.uid)
  on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
  update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal'),
         version = version + 1, updated_at = now() where id = p_room;
  update public.game_room_members set ready = false where room_id = p_room;
end $$;

-- 시작 (방장). p_laps = 1 또는 2 (모두 한 번씩 / 두 바퀴)
create or replace function public.qd_start(p_actor uuid, p_room uuid, p_laps int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; n int; res jsonb; laps int := case when p_laps = 2 then 2 else 1 end;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'sketch_quiz' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by random()) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  n := array_length(v_order, 1);
  delete from public.qd_turns where room_id = p_room;
  delete from public.qd_guess_meta where room_id = p_room;
  update public.game_rooms set state = jsonb_build_object('game', 'sketch_quiz', 'phase', 'pick', 'turn', 0, 'turns', least(16, n * laps), 'laps', laps,
      'order', to_jsonb(v_order), 'pick_sec', 10, 'draw_sec', 80, 'end_sec', 5, 'deadline', now() + interval '10 seconds')
   where id = p_room;
  perform public.qd_new_turn(p_room, 0);
  return jsonb_build_object('ok', true);
end $$;

-- 다음 단계로 (마감이 지났거나, 모두 맞혔거나, 그리는 사람이 나갔을 때)
create or replace function public.qd_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; ph text; t int; tr public.qd_turns; v_due boolean; v_need int; v_hits int; v_drawer_here boolean;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'sketch_quiz' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; ph := st->>'phase'; t := (st->>'turn')::int;
  v_due := now() >= (st->>'deadline')::timestamptz;
  select * into tr from public.qd_turns where room_id = p_room and turn = t;
  v_drawer_here := exists (select 1 from public.game_room_members where room_id = p_room and user_id = tr.drawer_id and left_at is null);
  if ph = 'pick' then
    if not v_due and v_drawer_here then return jsonb_build_object('ok', true, 'waiting', true); end if;
    if not v_drawer_here then ph := 'draw'; v_due := true;   -- 그리는 사람이 나감 → 이 차례는 바로 끝
    else
      update public.qd_turns set word = choices[1], draw_started = now() where room_id = p_room and turn = t;
      update public.game_rooms set state = st || jsonb_build_object('phase', 'draw', 'deadline', now() + make_interval(secs => (st->>'draw_sec')::int)),
             version = version + 1, updated_at = now() where id = p_room;
      return jsonb_build_object('ok', true, 'phase', 'draw');
    end if;
  end if;
  if ph = 'draw' then
    select count(*) into v_need from public.game_room_members where room_id = p_room and left_at is null and user_id is distinct from tr.drawer_id;
    select count(*) into v_hits from public.qd_hits h join public.game_room_members m on m.room_id = h.room_id and m.user_id = h.user_id and m.left_at is null
     where h.room_id = p_room and h.turn = t;
    if not v_due and v_drawer_here and (v_hits < v_need or v_need = 0) then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'turn_end', 'deadline', now() + make_interval(secs => (st->>'end_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'turn_end');
  end if;
  if ph = 'turn_end' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    if public.qd_new_turn(p_room, t + 1) then return jsonb_build_object('ok', true, 'turn', t + 1); end if;
    perform public.qd_finish(p_room);
    return jsonb_build_object('ok', true, 'ended', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'not_playing');
end $$;

-- 제시어 고르기 (그리는 사람, pick 단계)
create or replace function public.qd_pick(p_user uuid, p_room uuid, p_turn int, p_word text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; tr public.qd_turns;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'sketch_quiz' or r.status <> 'playing' or r.state->>'phase' <> 'pick' then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  st := r.state;
  if p_turn is distinct from (st->>'turn')::int then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  select * into tr from public.qd_turns where room_id = p_room and turn = p_turn;
  if tr.drawer_id is distinct from p_user then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
  if not (p_word = any(tr.choices)) then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
  update public.qd_turns set word = p_word, draw_started = now() where room_id = p_room and turn = p_turn;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'draw', 'deadline', now() + make_interval(secs => (st->>'draw_sec')::int)),
         version = version + 1, updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true);
end $$;

-- 획 조각 보내기 (그리는 사람, draw 단계). 판 버전은 올리지 않음(획은 따로 since 로 받아 감)
create or replace function public.qd_stroke(p_user uuid, p_room uuid, p_turn int, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_id bigint;
begin
  select * into r from public.game_rooms where id = p_room;
  if not found or r.game_key <> 'sketch_quiz' or r.status <> 'playing' or r.state->>'phase' <> 'draw'
     or p_turn is distinct from (r.state->>'turn')::int then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  if not exists (select 1 from public.qd_turns where room_id = p_room and turn = p_turn and drawer_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_player');
  end if;
  if jsonb_typeof(p_data) <> 'array' or char_length(p_data::text) > 16000 then return jsonb_build_object('ok', false, 'error', 'invalid_image'); end if;
  if (select count(*) from public.qd_strokes where room_id = p_room and turn = p_turn) >= 800 then return jsonb_build_object('ok', false, 'error', 'state_too_large'); end if;
  insert into public.qd_strokes (room_id, turn, data) values (p_room, p_turn, p_data) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 정답 확인 (그리는 사람이 아닌 참가자, draw 단계, 1.5초에 한 번). 틀린 답은 저장하지 않음
create or replace function public.qd_guess(p_user uuid, p_room uuid, p_turn int, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; tr public.qd_turns; v_last timestamptz; v_cnt int; v_pts int; g text; w text;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'sketch_quiz' or r.status <> 'playing' or r.state->>'phase' <> 'draw'
     or p_turn is distinct from (r.state->>'turn')::int then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  st := r.state;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select * into tr from public.qd_turns where room_id = p_room and turn = p_turn;
  if tr.drawer_id = p_user then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
  if exists (select 1 from public.qd_hits where room_id = p_room and turn = p_turn and user_id = p_user) then
    return jsonb_build_object('ok', true, 'correct', true, 'already', true);
  end if;
  select last_at into v_last from public.qd_guess_meta where room_id = p_room and user_id = p_user;
  if v_last is not null and v_last > now() - interval '1.5 seconds' then return jsonb_build_object('ok', false, 'error', 'too_fast'); end if;
  insert into public.qd_guess_meta (room_id, user_id, last_at) values (p_room, p_user, now())
  on conflict (room_id, user_id) do update set last_at = now();
  g := public.qd_norm(p_text); w := public.qd_norm(tr.word);
  if g = '' or char_length(g) > 20 then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
  if g <> w then return jsonb_build_object('ok', true, 'correct', false, 'close', public.qd_close(g, w)); end if;
  select count(*) into v_cnt from public.qd_hits where room_id = p_room and turn = p_turn;
  v_pts := (array[10, 8, 6, 5, 4, 3, 3, 3])[least(v_cnt + 1, 8)];
  insert into public.qd_hits (room_id, turn, user_id, points) values (p_room, p_turn, p_user, v_pts);
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  perform public.qd_advance(p_room);
  return jsonb_build_object('ok', true, 'correct', true, 'points', v_pts);
end $$;

-- 정리: 끝난 지 1일 지난 방의 릴레이·기억 조각·쓱싹 기록 지우기 (나머지는 0018 과 같음)
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int; f int;
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
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d + e + f);
end $$;

do $$ declare fn text; begin
  foreach fn in array array['qd_new_turn(uuid, int)', 'qd_finish(uuid)', 'qd_start(uuid, uuid, int)', 'qd_advance(uuid)', 'qd_pick(uuid, uuid, int, text)',
    'qd_stroke(uuid, uuid, int, jsonb)', 'qd_guess(uuid, uuid, int, text)', 'gm_housekeeping()', 'qd_close(text, text)', 'qd_norm(text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

commit;
