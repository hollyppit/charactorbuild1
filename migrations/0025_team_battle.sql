-- 0025_team_battle.sql  (게임 팀전: 🔴 빨강팀 vs 🔵 파랑팀)
-- 선행: 0016(game_rooms·gm_start), 0019(qd_*), 0021(qd_new_turn), 0023(pz_advance)
-- - games.teams: 팀전을 할 수 있는 게임(쓱싹 퀴즈·퀴즈 배틀·퍼즐 배틀)
-- - game_rooms.team_mode: 방장이 대기 중에 켜고 끔. 켜면 참가자를 두 팀으로 고르게 나누고, 새로 들어온 사람은 적은 팀으로
-- - game_room_members.team: 'red' | 'blue' (대기 중 본인 또는 방장이 바꿈, 팀당 4명까지)
-- - 시작 조건(팀전): 팀마다 2명 이상, 두 팀 인원 차이 1명 이하
-- - 끝나면(상태가 ended 로 바뀔 때) game_results 에 팀과 팀 결과(win/lose/draw) 기록. 팀 점수 = 팀원 점수 평균(인원 차이에 공평하게)
-- - 쓱싹 퀴즈 팀전: 두 팀이 번갈아 그림(인원이 적은 팀은 한 사람이 더 그림 — 두 팀 차례 수 같게), 같은 팀만 맞힐 수 있음
-- - 퍼즐 배틀 팀전: 한 팀이 모두 완성하면 바로 끝
begin;

alter table public.games add column if not exists teams boolean not null default false;
update public.games set teams = true where key in ('sketch_quiz', 'quiz_battle', 'jigsaw');
alter table public.game_rooms add column if not exists team_mode boolean not null default false;
alter table public.game_room_members add column if not exists team text check (team in ('red', 'blue'));
alter table public.game_results add column if not exists team text check (team in ('red', 'blue'));
alter table public.game_results add column if not exists team_result text check (team_result in ('win', 'lose', 'draw'));

-- 지금 사람이 적은 팀 (같으면 빨강)
create or replace function public.gm_team_pick(p_room uuid) returns text language sql stable security definer set search_path = public as $$
  select case when count(*) filter (where team = 'blue') < count(*) filter (where team = 'red') then 'blue' else 'red' end
    from public.game_room_members where room_id = p_room and left_at is null;
$$;

-- 참가자를 무작위로 두 팀에 고르게
create or replace function public.gm_team_shuffle(p_room uuid) returns void language sql security definer set search_path = public as $$
  update public.game_room_members m set team = case when x.rn % 2 = 1 then 'red' else 'blue' end
    from (select user_id, row_number() over (order by random()) as rn from public.game_room_members where room_id = p_room and left_at is null) x
   where m.room_id = p_room and m.user_id = x.user_id;
$$;

-- 팀전 방에 새로 들어오거나 다시 들어온 사람은 적은 팀으로 (대기 중일 때만)
create or replace function public.gm_member_team() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.left_at is null and new.team is null
     and exists (select 1 from public.game_rooms where id = new.room_id and team_mode and status = 'waiting') then
    new.team := public.gm_team_pick(new.room_id);
  end if;
  return new;
end $$;
drop trigger if exists game_room_members_team on public.game_room_members;
create trigger game_room_members_team before insert or update of left_at, team on public.game_room_members
  for each row execute function public.gm_member_team();

-- 팀전 켜기·끄기 (방장, 대기 중)
create or replace function public.gm_team_mode(p_actor uuid, p_room uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  if r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'error', 'already_started'); end if;
  if p_on and not coalesce((select teams from public.games where key = r.game_key), false) then
    return jsonb_build_object('ok', false, 'error', 'no_team_mode');
  end if;
  update public.game_rooms set team_mode = p_on where id = p_room;
  if p_on then perform public.gm_team_shuffle(p_room);
  else update public.game_room_members set team = null where room_id = p_room; end if;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- 팀 자동으로 다시 나누기 (방장, 대기 중)
create or replace function public.gm_team_auto(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  if r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'error', 'already_started'); end if;
  if not r.team_mode then return jsonb_build_object('ok', false, 'error', 'not_team_mode'); end if;
  perform public.gm_team_shuffle(p_room);
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- 팀 바꾸기 (본인 또는 방장, 대기 중, 팀당 4명까지)
create or replace function public.gm_team_set(p_actor uuid, p_room uuid, p_target uuid, p_team text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'error', 'already_started'); end if;
  if not r.team_mode then return jsonb_build_object('ok', false, 'error', 'not_team_mode'); end if;
  if p_team is null or p_team not in ('red', 'blue') then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_actor and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if p_actor <> p_target and r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_target and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if (select count(*) from public.game_room_members where room_id = p_room and left_at is null and team = p_team and user_id <> p_target) >= 4 then
    return jsonb_build_object('ok', false, 'error', 'team_full');
  end if;
  update public.game_room_members set team = p_team where room_id = p_room and user_id = p_target;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- 시작 (0016 + 팀전 조건)
create or replace function public.gm_start(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_min int; v_cnt int; v_red int; v_blue int; u uuid;
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
  if r.team_mode then
    for u in select user_id from public.game_room_members where room_id = p_room and left_at is null and team is null loop
      update public.game_room_members set team = public.gm_team_pick(p_room) where room_id = p_room and user_id = u;
    end loop;
    select count(*) filter (where team = 'red'), count(*) filter (where team = 'blue') into v_red, v_blue
      from public.game_room_members where room_id = p_room and left_at is null;
    if least(v_red, v_blue) < 2 then return jsonb_build_object('ok', false, 'error', 'team_too_small'); end if;
    if abs(v_red - v_blue) > 1 then return jsonb_build_object('ok', false, 'error', 'team_unbalanced'); end if;
  end if;
  update public.game_rooms set status = 'playing', started_at = now() where id = p_room;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- 팀 결과 기록 (팀전 방이 끝날 때)
create or replace function public.gm_team_results(p_room uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_red numeric; v_blue numeric; v_win text;
begin
  update public.game_results g set team = m.team
    from public.game_room_members m where m.room_id = g.room_id and m.user_id = g.user_id and g.room_id = p_room;
  select coalesce(avg(score) filter (where team = 'red'), 0), coalesce(avg(score) filter (where team = 'blue'), 0) into v_red, v_blue
    from public.game_results where room_id = p_room;
  v_win := case when v_red > v_blue then 'red' when v_blue > v_red then 'blue' else null end;
  update public.game_results set team_result = case when team is null then null when v_win is null then 'draw' when team = v_win then 'win' else 'lose' end
   where room_id = p_room;
end $$;
create or replace function public.gm_room_ended() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.gm_team_results(new.id);
  return null;
end $$;
drop trigger if exists game_rooms_team_results on public.game_rooms;
create trigger game_rooms_team_results after update of status on public.game_rooms
  for each row when (new.status = 'ended' and old.status is distinct from 'ended' and new.team_mode)
  execute function public.gm_room_ended();

-- ── 쓱싹 퀴즈 팀전 ──
-- 차례 하나 준비 (0021 + 팀전이면 draw_order 순서로)
create or replace function public.qd_new_turn(p_room uuid, p_turn int)
returns boolean language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; n int; t int; v_drawer uuid; v_choices text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(coalesce(st->'draw_order', st->'order')) with ordinality q(x, o);
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

-- 시작 (0019 + 팀전이면 두 팀이 번갈아 그리는 순서)
create or replace function public.qd_start(p_actor uuid, p_room uuid, p_laps int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; n int; res jsonb; laps int := case when p_laps = 2 then 2 else 1 end;
        v_a uuid[]; v_b uuid[]; v_draw uuid[] := '{}'; mx int; i int; v_first text;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'sketch_quiz' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by random()) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  n := array_length(v_order, 1);
  if r.team_mode then
    v_first := case when random() < 0.5 then 'red' else 'blue' end;
    select array_agg(user_id order by random()) into v_a from public.game_room_members where room_id = p_room and left_at is null and team = v_first;
    select array_agg(user_id order by random()) into v_b from public.game_room_members where room_id = p_room and left_at is null and team <> v_first;
    mx := greatest(array_length(v_a, 1), array_length(v_b, 1));
    for i in 0..mx - 1 loop
      v_draw := v_draw || v_a[(i % array_length(v_a, 1)) + 1] || v_b[(i % array_length(v_b, 1)) + 1];
    end loop;
    n := array_length(v_draw, 1);
  end if;
  delete from public.qd_turns where room_id = p_room;
  delete from public.qd_guess_meta where room_id = p_room;
  update public.game_rooms set state = jsonb_build_object('game', 'sketch_quiz', 'phase', 'pick', 'turn', 0, 'turns', least(16, n * laps), 'laps', laps,
      'order', to_jsonb(v_order), 'pick_sec', 10, 'draw_sec', 80, 'end_sec', 5, 'deadline', now() + interval '10 seconds')
      || case when r.team_mode then jsonb_build_object('draw_order', to_jsonb(v_draw), 'teams', true) else '{}'::jsonb end
   where id = p_room;
  perform public.qd_new_turn(p_room, 0);
  return jsonb_build_object('ok', true);
end $$;

-- 다음 단계 (0019 + 팀전이면 그리는 사람 팀만 다 맞히면 넘어감)
create or replace function public.qd_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; ph text; t int; tr public.qd_turns; v_due boolean; v_need int; v_hits int; v_drawer_here boolean; v_team text;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'sketch_quiz' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; ph := st->>'phase'; t := (st->>'turn')::int;
  v_due := now() >= (st->>'deadline')::timestamptz;
  select * into tr from public.qd_turns where room_id = p_room and turn = t;
  v_drawer_here := exists (select 1 from public.game_room_members where room_id = p_room and user_id = tr.drawer_id and left_at is null);
  if r.team_mode then select team into v_team from public.game_room_members where room_id = p_room and user_id = tr.drawer_id; end if;
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
    select count(*) into v_need from public.game_room_members where room_id = p_room and left_at is null and user_id is distinct from tr.drawer_id
       and (not r.team_mode or team = v_team);
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

-- 정답 확인 (0019 + 팀전이면 그리는 사람과 같은 팀만)
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
  if r.team_mode and (select team from public.game_room_members where room_id = p_room and user_id = p_user)
                     is distinct from (select team from public.game_room_members where room_id = p_room and user_id = tr.drawer_id) then
    return jsonb_build_object('ok', false, 'error', 'not_your_team');
  end if;
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

-- ── 퍼즐 배틀 팀전: 한 팀이 모두 완성하면 바로 끝 (0023 + 팀 조건) ──
create or replace function public.pz_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_need int; v_done int; v_team_done boolean := false;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'jigsaw' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  select count(*) into v_need from public.game_room_members m where m.room_id = p_room and m.left_at is null
     and m.user_id in (select x::uuid from jsonb_array_elements_text(r.state->'order') x);
  select count(*) into v_done from public.pz_progress p join public.game_room_members m on m.room_id = p.room_id and m.user_id = p.user_id and m.left_at is null
   where p.room_id = p_room and p.finished_at is not null;
  if r.team_mode then
    select coalesce(bool_or(all_done), false) into v_team_done from (
      select m.team, bool_and(p.finished_at is not null) as all_done
        from public.game_room_members m left join public.pz_progress p on p.room_id = m.room_id and p.user_id = m.user_id
       where m.room_id = p_room and m.left_at is null and m.team is not null
         and m.user_id in (select x::uuid from jsonb_array_elements_text(r.state->'order') x)
       group by m.team) t;
  end if;
  if v_done < v_need and not v_team_done and now() < (r.state->>'deadline')::timestamptz then return jsonb_build_object('ok', true, 'waiting', true); end if;
  perform public.pz_finish(p_room);
  return jsonb_build_object('ok', true, 'ended', true);
end $$;

-- 새 함수 잠금 (서버만)
revoke all on function public.gm_team_pick(uuid), public.gm_team_shuffle(uuid), public.gm_member_team(), public.gm_team_mode(uuid, uuid, boolean),
  public.gm_team_auto(uuid, uuid), public.gm_team_set(uuid, uuid, uuid, text), public.gm_team_results(uuid), public.gm_room_ended() from public, anon, authenticated;
grant execute on function public.gm_team_pick(uuid), public.gm_team_shuffle(uuid), public.gm_team_mode(uuid, uuid, boolean),
  public.gm_team_auto(uuid, uuid), public.gm_team_set(uuid, uuid, uuid, text), public.gm_team_results(uuid) to service_role;

commit;
