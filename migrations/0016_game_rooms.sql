-- 0016_game_rooms.sql  (5단계: 게임 확장 구조 — 게임 자체는 없음. 방·입장 코드·초대·준비·시작·결과 기록의 공통 틀)
-- 선행: 0003(profiles), 0009(social_active_sanction), 0010(social_notify, social_is_blocked, follows, notifications), 0012(groups, group_members)
-- 규칙(학생 보호): 채팅 없음 / 초대는 서로 팔로우 또는 같은 그룹만 / 입장 코드 2시간 / 차단 관계면 같은 방 불가 /
--                 방 최대 8명 / 한 사람이 동시에 들어가 있는 방 3개 / 하루 방 만들기 20개 / 이용 제한 중 불가
-- 모든 함수는 서버(service_role)만 실행. 표는 RLS 켜고 정책 없음(바깥 직접 접근 불가).

begin;

create table if not exists public.games (
  key          text primary key check (key ~ '^[a-z0-9_]{2,30}$'),
  title        text not null check (char_length(title) between 1 and 40),
  status       text not null default 'off' check (status in ('off','beta','on')),   -- beta = 관리자 역할 회원만 보임
  min_players  int not null default 1 check (min_players between 1 and 8),
  max_players  int not null default 8 check (max_players between 1 and 8),
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  check (min_players <= max_players)
);
insert into public.games (key, title, status, min_players, max_players, sort)
values ('ready_check', '준비 확인 시험', 'beta', 1, 8, 0) on conflict (key) do nothing;

create table if not exists public.game_rooms (
  id           uuid primary key default gen_random_uuid(),
  game_key     text not null references public.games(key) on delete cascade,
  host_id      uuid references public.profiles(id) on delete set null,
  status       text not null default 'waiting' check (status in ('waiting','playing','ended','closed')),
  join_code    text not null check (join_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  max_players  int not null default 8 check (max_players between 1 and 8),
  state        jsonb not null default '{}'::jsonb,       -- 게임이 쓰는 칸 (16KB 까지)
  version      int not null default 1,                   -- 방·참가자·상태가 바뀔 때마다 +1 (화면이 바뀐 것만 받아 가도록)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  started_at   timestamptz,
  ended_at     timestamptz,
  expires_at   timestamptz not null default now() + interval '2 hours'   -- 이때까지 시작하지 않으면 닫힘
);
-- 진행 중인 방끼리는 입장 코드가 겹치지 않음
create unique index if not exists game_rooms_active_code on public.game_rooms (join_code) where status in ('waiting','playing');
create index if not exists game_rooms_host_day on public.game_rooms (host_id, created_at desc);
create index if not exists game_rooms_status on public.game_rooms (status, updated_at);

create table if not exists public.game_room_members (
  room_id    uuid not null references public.game_rooms(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'player' check (role in ('host','player')),
  ready      boolean not null default false,
  kicked     boolean not null default false,             -- 내보낸 사람은 코드로 다시 들어올 수 없음
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (room_id, user_id)
);
create index if not exists game_room_members_user on public.game_room_members (user_id) where left_at is null;

create table if not exists public.game_results (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  rank        int check (rank is null or rank between 1 and 100),
  score       numeric check (score is null or abs(score) < 1e9),
  created_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table public.games             enable row level security;
alter table public.game_rooms        enable row level security;
alter table public.game_room_members enable row level security;
alter table public.game_results      enable row level security;
revoke all on public.games, public.game_rooms, public.game_room_members, public.game_results from anon, authenticated;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed',
  'gs_assigned','gs_submitted','gs_approved','gs_returned',
  'gp_consent','gp_declined','gp_ready','gp_published',
  'game_invite'));

-- ── 도우미 ──
create or replace function public.gm_bump(p_room uuid) returns void language sql security definer set search_path = public as $$
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
$$;
-- 지금 들어가 있는(나가지 않은) 방 중 진행 중인 방 수
create or replace function public.gm_active_rooms(p_user uuid) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.game_room_members m join public.game_rooms r on r.id = m.room_id
   where m.user_id = p_user and m.left_at is null and r.status in ('waiting','playing')
     and not (r.status = 'waiting' and r.expires_at < now());
$$;
-- 시간이 지난 대기 방은 닫음 (읽거나 들어갈 때 함께 정리)
create or replace function public.gm_expire(p_room uuid) returns void language sql security definer set search_path = public as $$
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where id = p_room and status = 'waiting' and expires_at < now();
$$;

-- ── 방 만들기 ──
create or replace function public.gm_create(p_user uuid, p_game text, p_max int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare g public.games; v_room uuid; v_code text; i int; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  perform pg_advisory_xact_lock(hashtext('gm_user:' || p_user::text));
  select * into g from public.games where key = p_game and status <> 'off';
  if not found then return jsonb_build_object('ok', false, 'error', 'game_not_found'); end if;
  if public.social_active_sanction(p_user) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if public.gm_active_rooms(p_user) >= 3 then return jsonb_build_object('ok', false, 'error', 'too_many_rooms'); end if;
  if (select count(*) from public.game_rooms where host_id = p_user and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'daily_room_limit');
  end if;
  for attempt in 1..20 loop
    v_code := '';
    for i in 1..6 loop v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.game_rooms where join_code = v_code and status in ('waiting','playing'));
    v_code := null;
  end loop;
  if v_code is null then return jsonb_build_object('ok', false, 'error', 'try_again'); end if;
  insert into public.game_rooms (game_key, host_id, join_code, max_players)
  values (g.key, p_user, v_code, greatest(g.min_players, least(g.max_players, coalesce(p_max, g.max_players))))
  returning id into v_room;
  insert into public.game_room_members (room_id, user_id, role) values (v_room, p_user, 'host');
  return jsonb_build_object('ok', true, 'id', v_room, 'code', v_code);
end $$;

-- ── 코드로 들어가기 ──
create or replace function public.gm_join(p_user uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; m public.game_room_members; v_cnt int;
begin
  select * into r from public.game_rooms where join_code = upper(p_code) and status in ('waiting','playing') for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  perform public.gm_expire(r.id);
  if r.status = 'waiting' and r.expires_at < now() then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  select * into m from public.game_room_members where room_id = r.id and user_id = p_user;
  if found and m.left_at is null then return jsonb_build_object('ok', true, 'id', r.id, 'already', true); end if;
  if found and m.kicked then return jsonb_build_object('ok', false, 'error', 'kicked'); end if;
  if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'error', 'already_started'); end if;
  if public.social_active_sanction(p_user) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if exists (select 1 from public.game_room_members x where x.room_id = r.id and x.left_at is null and public.social_is_blocked(p_user, x.user_id)) then
    return jsonb_build_object('ok', false, 'error', 'room_not_found');   -- 차단 관계는 알리지 않음
  end if;
  select count(*) into v_cnt from public.game_room_members where room_id = r.id and left_at is null;
  if v_cnt >= r.max_players then return jsonb_build_object('ok', false, 'error', 'room_full'); end if;
  if public.gm_active_rooms(p_user) >= 3 then return jsonb_build_object('ok', false, 'error', 'too_many_rooms'); end if;
  insert into public.game_room_members (room_id, user_id, role) values (r.id, p_user, 'player')
  on conflict (room_id, user_id) do update set left_at = null, ready = false, joined_at = now(), role = 'player';
  perform public.gm_bump(r.id);
  return jsonb_build_object('ok', true, 'id', r.id);
end $$;

-- ── 초대 (방장만, 서로 팔로우하거나 같은 그룹인 사람만) ──
create or replace function public.gm_invite(p_actor uuid, p_room uuid, p_invitee uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_title text;
begin
  select * into r from public.game_rooms where id = p_room;
  if not found or r.host_id is distinct from p_actor or r.status <> 'waiting' or r.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'not_host');
  end if;
  if p_invitee = p_actor or not exists (select 1 from public.profiles where id = p_invitee) or public.social_is_blocked(p_actor, p_invitee) then
    return jsonb_build_object('ok', false, 'error', 'user_not_found');
  end if;
  if not (
    (exists (select 1 from public.follows where follower_id = p_actor and followee_id = p_invitee and status = 'accepted')
     and exists (select 1 from public.follows where follower_id = p_invitee and followee_id = p_actor and status = 'accepted'))
    or exists (select 1 from public.group_members a join public.group_members b on a.group_id = b.group_id
                 join public.groups g on g.id = a.group_id and g.deleted_at is null
                where a.user_id = p_actor and b.user_id = p_invitee)
  ) then return jsonb_build_object('ok', false, 'error', 'not_friend'); end if;
  if exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_invitee and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'already_member');
  end if;
  -- 같은 방에서 같은 친구에게 10분 안에 다시 초대하지 않음
  if exists (select 1 from public.notifications where user_id = p_invitee and type = 'game_invite' and data->>'room_id' = p_room::text and created_at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  select title into v_title from public.games where key = r.game_key;
  perform public.social_notify(p_invitee, 'game_invite', p_actor, null, null, jsonb_build_object('room_id', p_room, 'code', r.join_code, 'game', v_title));
  return jsonb_build_object('ok', true);
end $$;

-- ── 나가기 (방장이 나가면 가장 먼저 들어온 사람이 방장, 아무도 없으면 닫힘) ──
create or replace function public.gm_leave(p_user uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_next uuid;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  update public.game_room_members set left_at = now(), ready = false, role = 'player' where room_id = p_room and user_id = p_user;
  if r.host_id = p_user then
    select user_id into v_next from public.game_room_members where room_id = p_room and left_at is null order by joined_at limit 1;
    if v_next is null then
      update public.game_rooms set host_id = null, status = case when status in ('waiting','playing') then 'closed' else status end,
             ended_at = coalesce(ended_at, now()) where id = p_room;
    else
      update public.game_room_members set role = 'host', ready = false where room_id = p_room and user_id = v_next;
      update public.game_rooms set host_id = v_next where id = p_room;
    end if;
  end if;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- ── 내보내기 (방장, 기다리는 중에만) ──
create or replace function public.gm_kick(p_actor uuid, p_room uuid, p_target uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if r.status <> 'waiting' then return jsonb_build_object('ok', false, 'error', 'already_started'); end if;
  if p_target = p_actor or not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_target and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  update public.game_room_members set left_at = now(), ready = false, kicked = true where room_id = p_room and user_id = p_target;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- ── 준비 ──
create or replace function public.gm_ready(p_user uuid, p_room uuid, p_ready boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.game_rooms where id = p_room and status = 'waiting')
     or not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  update public.game_room_members set ready = p_ready where room_id = p_room and user_id = p_user;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- ── 시작 (방장, 최소 인원 이상이고 방장 말고 모두 준비) ──
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

-- ── 게임 상태 쓰기 (방장, 진행 중, 버전이 맞을 때만 — 동시에 쓰면 한쪽은 다시 시도) ──
create or replace function public.gm_set_state(p_actor uuid, p_room uuid, p_state jsonb, p_version int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  if r.version <> p_version then return jsonb_build_object('ok', false, 'error', 'version_conflict', 'version', r.version); end if;
  if length(p_state::text) > 16384 then return jsonb_build_object('ok', false, 'error', 'state_too_large'); end if;
  update public.game_rooms set state = coalesce(p_state, '{}'::jsonb), version = version + 1, updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true, 'version', r.version + 1);
end $$;

-- ── 끝내기 (방장, 진행 중) + 결과 기록. p_results = [{user_id, rank, score}] (이 방에 들어왔던 사람만) ──
create or replace function public.gm_end(p_actor uuid, p_room uuid, p_results jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; x jsonb;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.host_id is distinct from p_actor then return jsonb_build_object('ok', false, 'error', 'not_host'); end if;
  if r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  for x in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if exists (select 1 from public.game_room_members where room_id = p_room and user_id = (x->>'user_id')::uuid) then
      insert into public.game_results (room_id, user_id, rank, score)
      values (p_room, (x->>'user_id')::uuid, nullif(x->>'rank', '')::int, nullif(x->>'score', '')::numeric)
      on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
    end if;
  end loop;
  update public.game_rooms set status = 'ended', ended_at = now() where id = p_room;
  update public.game_room_members set ready = false where room_id = p_room;
  perform public.gm_bump(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- ── 정리 (서버가 가끔 호출): 시간 지난 대기 방 닫기, 6시간 넘게 진행 중인 방 닫기, 끝난 지 90일 지난 방(결과 포함) 지우기 ──
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int;
begin
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'waiting' and expires_at < now();
  get diagnostics a = row_count;
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'playing' and started_at < now() - interval '6 hours';
  get diagnostics b = row_count;
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'gm_bump(uuid)', 'gm_active_rooms(uuid)', 'gm_expire(uuid)', 'gm_create(uuid, text, int)', 'gm_join(uuid, text)',
    'gm_invite(uuid, uuid, uuid)', 'gm_leave(uuid, uuid)', 'gm_kick(uuid, uuid, uuid)', 'gm_ready(uuid, uuid, boolean)',
    'gm_start(uuid, uuid)', 'gm_set_state(uuid, uuid, jsonb, int)', 'gm_end(uuid, uuid, jsonb)', 'gm_housekeeping()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
