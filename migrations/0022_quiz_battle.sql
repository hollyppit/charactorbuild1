-- 0022_quiz_battle.sql  (이미지 상식 퀴즈 "친구와 배틀")
-- 선행: 0016(game_rooms, gm_start), 0020(gm_housekeeping 갱신본), char_items(category='quiz': label=문제, src=그림, src_back=보기 JSON 배열, bg_emoji=정답 번호)
-- 진행: 방장이 문제 수(5|10) → 문제마다 question(15초: 모두 같은 문제, 한 번만 답) → reveal(3초: 정답·맞힌 사람) → 다음 문제.
--   모두 답하면 바로 reveal. 점수: 맞히면 100 + 남은 시간 비례 보너스(최대 50). 정답 번호는 서버(표)만 알고 답한 뒤 공개.
-- 문제는 시작할 때 복사해 두므로 게임 중에 관리자가 퀴즈를 고쳐도 영향 없음. 기록은 끝나고 1일 뒤 삭제.

begin;

insert into public.games (key, title, status, min_players, max_players, sort)
values ('quiz_battle', '이미지 상식 퀴즈 배틀', 'beta', 2, 8, 5) on conflict (key) do nothing;

create table if not exists public.qb_questions (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  q           int not null check (q between 0 and 19),
  question    text not null,
  image       text not null,
  options     text[] not null,
  correct     int not null,
  started_at  timestamptz,
  primary key (room_id, q)
);
create table if not exists public.qb_answers (
  room_id  uuid not null references public.game_rooms(id) on delete cascade,
  q        int not null,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  choice   int not null,
  correct  boolean not null,
  points   int not null,
  at       timestamptz not null default now(),
  primary key (room_id, q, user_id)
);
alter table public.qb_questions enable row level security;
alter table public.qb_answers   enable row level security;
revoke all on public.qb_questions, public.qb_answers from anon, authenticated;

-- 보기 JSON 을 안전하게 읽기 (형식이 잘못된 퀴즈는 null → 건너뜀)
create or replace function public.qb_opts(t text) returns text[] language plpgsql immutable as $$
begin
  if t is null or t !~ '^\s*\[' then return null; end if;
  return array(select jsonb_array_elements_text(t::jsonb));
exception when others then return null;
end $$;

-- 시작 (방장). p_count = 5 또는 10 (등록된 퀴즈가 적으면 있는 만큼, 최소 3개)
create or replace function public.qb_start(p_actor uuid, p_room uuid, p_count int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; res jsonb; n int; cnt int := case when p_count = 5 then 5 else 10 end;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'quiz_battle' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  select count(*) into n from public.char_items
   where category = 'quiz' and coalesce(src, '') <> '' and coalesce(array_length(public.qb_opts(src_back), 1), 0) >= 2
     and coalesce(bg_emoji, '0') ~ '^[0-9]+$' and coalesce(nullif(bg_emoji, '')::int, 0) < array_length(public.qb_opts(src_back), 1);
  if n < 3 then return jsonb_build_object('ok', false, 'error', 'not_enough_quiz'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by joined_at) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  delete from public.qb_questions where room_id = p_room;
  delete from public.qb_answers where room_id = p_room;
  insert into public.qb_questions (room_id, q, question, image, options, correct)
  select p_room, (row_number() over () - 1)::int, coalesce(label, ''), src, public.qb_opts(src_back), coalesce(nullif(bg_emoji, '')::int, 0)
    from (select * from public.char_items
           where category = 'quiz' and coalesce(src, '') <> '' and coalesce(array_length(public.qb_opts(src_back), 1), 0) >= 2
             and coalesce(bg_emoji, '0') ~ '^[0-9]+$' and coalesce(nullif(bg_emoji, '')::int, 0) < array_length(public.qb_opts(src_back), 1)
           order by random() limit least(cnt, 20)) t;
  get diagnostics n = row_count;
  update public.qb_questions set started_at = now() where room_id = p_room and q = 0;
  update public.game_rooms set state = jsonb_build_object('game', 'quiz_battle', 'phase', 'question', 'q', 0, 'total', n, 'order', to_jsonb(v_order),
      'q_sec', 15, 'reveal_sec', 3, 'deadline', now() + interval '15 seconds'),
    version = version + 1, updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true, 'total', n);
end $$;

-- 다음 단계로 (모두 답했거나 마감이 지났을 때)
create or replace function public.qb_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; ph text; v_q int; v_due boolean; v_need int; v_done int; v_order uuid[];
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'quiz_battle' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; ph := st->>'phase'; v_q := (st->>'q')::int;
  v_due := now() >= (st->>'deadline')::timestamptz;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  if ph = 'question' then
    select count(*) into v_need from public.game_room_members where room_id = p_room and left_at is null and user_id = any(v_order);
    select count(*) into v_done from public.qb_answers a join public.game_room_members m on m.room_id = a.room_id and m.user_id = a.user_id and m.left_at is null
     where a.room_id = p_room and a.q = v_q;
    if v_done < v_need and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'reveal', 'deadline', now() + make_interval(secs => (st->>'reveal_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'reveal');
  end if;
  if ph = 'reveal' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    if v_q + 1 < (st->>'total')::int then
      update public.qb_questions set started_at = now() where room_id = p_room and q = v_q + 1;
      update public.game_rooms set state = st || jsonb_build_object('phase', 'question', 'q', v_q + 1, 'deadline', now() + make_interval(secs => (st->>'q_sec')::int)),
             version = version + 1, updated_at = now() where id = p_room;
      return jsonb_build_object('ok', true, 'q', v_q + 1);
    end if;
    with sc as (
      select u.uid, coalesce((select sum(points) from public.qb_answers a where a.room_id = p_room and a.user_id = u.uid), 0) as score
        from unnest(v_order) as u(uid)
    )
    insert into public.game_results (room_id, user_id, rank, score)
    select p_room, sc.uid, dense_rank() over (order by sc.score desc), sc.score from sc
     where exists (select 1 from public.profiles where id = sc.uid)
    on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
    update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal_end'),
           version = version + 1, updated_at = now() where id = p_room;
    update public.game_room_members set ready = false where room_id = p_room;
    return jsonb_build_object('ok', true, 'ended', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'not_playing');
end $$;

-- 답하기 (참가자, question 단계, 문제마다 한 번)
create or replace function public.qb_answer(p_user uuid, p_room uuid, p_q int, p_choice int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; qq public.qb_questions; v_ok boolean; v_pts int; v_left numeric;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'quiz_battle' or r.status <> 'playing' or r.state->>'phase' <> 'question'
     or p_q is distinct from (r.state->>'q')::int then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  st := r.state;
  if now() > (st->>'deadline')::timestamptz then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null)
     or not exists (select 1 from jsonb_array_elements_text(st->'order') x where x::uuid = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_player');
  end if;
  if exists (select 1 from public.qb_answers where room_id = p_room and q = p_q and user_id = p_user) then return jsonb_build_object('ok', false, 'error', 'already_answered'); end if;
  select * into qq from public.qb_questions where room_id = p_room and q = p_q;
  if p_choice is null or p_choice < 0 or p_choice >= array_length(qq.options, 1) then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
  v_ok := p_choice = qq.correct;
  v_left := greatest(0, extract(epoch from ((st->>'deadline')::timestamptz - now())));
  v_pts := case when v_ok then 100 + round(50 * least(1, v_left / greatest(1, (st->>'q_sec')::int)))::int else 0 end;
  insert into public.qb_answers (room_id, q, user_id, choice, correct, points) values (p_room, p_q, p_user, p_choice, v_ok, v_pts);
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  perform public.qb_advance(p_room);
  return jsonb_build_object('ok', true, 'correct', v_ok, 'points', v_pts, 'answer', qq.correct);
end $$;

-- 정리: 끝난 지 1일 지난 퀴즈 배틀 기록 지우기 (나머지는 0020 과 같음)
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
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d + e + f + g);
end $$;

do $$ declare fn text; begin
  foreach fn in array array['qb_opts(text)', 'qb_start(uuid, uuid, int)', 'qb_advance(uuid)', 'qb_answer(uuid, uuid, int, int)', 'gm_housekeeping()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

commit;
