-- 0025 되돌리기: 팀전 끄기 (함수는 0016·0019·0021·0023 모양으로, 팀 칸 삭제 — 팀 결과 기록도 지워짐)
begin;
drop trigger if exists game_rooms_team_results on public.game_rooms;
drop trigger if exists game_room_members_team on public.game_room_members;
drop function if exists public.gm_room_ended();
drop function if exists public.gm_team_results(uuid);
drop function if exists public.gm_team_set(uuid, uuid, uuid, text);
drop function if exists public.gm_team_auto(uuid, uuid);
drop function if exists public.gm_team_mode(uuid, uuid, boolean);
drop function if exists public.gm_member_team();
drop function if exists public.gm_team_shuffle(uuid);
drop function if exists public.gm_team_pick(uuid);

create or replace function public.gm_start(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_min int; v_cnt int;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if r.status <> 'waiting' or r.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'already_started'); end if;
  select min_players into v_min from public.games where key = r.game_key;
  select count(*) into v_cnt from public.game_room_members where room_id = p_room and left_at is null;
  if v_cnt < v_min then return jsonb_build_object('ok', false, 'error', 'not_enough_players', 'min', v_min); end if;
  if exists (select 1 from public.game_room_members where room_id = p_room and left_at is null and role <> 'host' and not ready) then
    return jsonb_build_object('ok', false, 'error', 'not_all_ready');
  end if;
  update public.game_rooms set status = 'playing', started_at = now() where id = p_room;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

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
    select word from public.game_words where active and 'sketch_quiz' = any(games) and word not in (select coalesce(word, '') from public.qd_turns where room_id = p_room)
     order by random() limit 3) w;
  insert into public.qd_turns (room_id, turn, drawer_id, choices) values (p_room, t, v_drawer, v_choices)
  on conflict (room_id, turn) do update set drawer_id = excluded.drawer_id, choices = excluded.choices, word = null, draw_started = null;
  delete from public.qd_strokes where room_id = p_room and turn = t;
  delete from public.qd_hits where room_id = p_room and turn = t;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'pick', 'turn', t, 'deadline', now() + make_interval(secs => (st->>'pick_sec')::int)),
         version = version + 1, updated_at = now() where id = p_room;
  return true;
end $$;

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

alter table public.game_results drop column if exists team_result;
alter table public.game_results drop column if exists team;
alter table public.game_room_members drop column if exists team;
alter table public.game_rooms drop column if exists team_mode;
alter table public.games drop column if exists teams;
commit;
