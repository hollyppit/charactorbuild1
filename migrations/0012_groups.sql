-- 0012_groups.sql  (4단계-A: 그룹·역할·초대)
-- 선행: 0003(profiles), 0009(social_active_sanction), 0010(social_is_blocked, social_notify, notifications)
-- 모든 접근은 서버(service_role)가 함수·REST 로 수행한다. 클라이언트 직접 접근 없음(RLS 켜고 정책 없음).
-- 규칙: 그룹은 항상 비공개(그룹원만 봄), 최대 10명(초대 대기 포함), 한 사람은 그룹 5개까지.
--       역할: owner(모둠장, 1명) / editor(만들기) / viewer(보기). 초대는 닉네임으로, 상대가 수락해야 가입.
--       차단 관계인 사람은 초대할 수 없고, 이용 제한 중이면 그룹을 만들거나 초대할 수 없다.

begin;

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 30),
  intro       text check (intro is null or char_length(intro) <= 200),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists groups_owner on public.groups (owner_id);

create table if not exists public.group_members (
  group_id   uuid not null references public.groups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null check (role in ('owner','editor','viewer')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user on public.group_members (user_id);

create table if not exists public.group_invites (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups(id) on delete cascade,
  inviter_id    uuid references public.profiles(id) on delete set null,
  invitee_id    uuid not null references public.profiles(id) on delete cascade,
  role          text not null default 'editor' check (role in ('editor','viewer')),
  status        text not null default 'pending' check (status in ('pending','accepted','declined','canceled')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);
create unique index if not exists group_invites_one_pending on public.group_invites (group_id, invitee_id) where status = 'pending';
create index if not exists group_invites_invitee on public.group_invites (invitee_id, status);

alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
revoke all on public.groups, public.group_members, public.group_invites from anon, authenticated;

-- 알림 종류 추가 (그룹 정보는 data 에 {group_id, group_name})
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed'));

-- 내부: 그룹 인원(가입 + 초대 대기)
create or replace function public.group_seats(p_group uuid) returns int
language sql stable security definer set search_path = public as $$
  select (select count(*) from public.group_members where group_id = p_group)::int
       + (select count(*) from public.group_invites where group_id = p_group and status = 'pending')::int;
$$;

-- 그룹 만들기 → {ok, id} / {ok:false, error}
create or replace function public.group_create(p_owner uuid, p_name text, p_intro text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('groups:' || p_owner::text));
  if public.social_active_sanction(p_owner) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if (select count(*) from public.group_members m join public.groups g on g.id = m.group_id
       where m.user_id = p_owner and g.deleted_at is null) >= 5 then
    return jsonb_build_object('ok', false, 'error', 'group_limit');
  end if;
  insert into public.groups (name, intro, owner_id) values (p_name, nullif(p_intro, ''), p_owner) returning id into v_id;
  insert into public.group_members (group_id, user_id, role) values (v_id, p_owner, 'owner');
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 초대 (모둠장만) → {ok, id} / {ok:false, error}
create or replace function public.group_invite(p_actor uuid, p_group uuid, p_invitee uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.groups; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('group:' || p_group::text));
  select * into g from public.groups where id = p_group and deleted_at is null;
  if not found or g.owner_id <> p_actor then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  if public.social_active_sanction(p_actor) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if p_invitee = p_actor or not exists (select 1 from public.profiles where id = p_invitee) or public.social_is_blocked(p_actor, p_invitee) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if exists (select 1 from public.group_members where group_id = p_group and user_id = p_invitee) then return jsonb_build_object('ok', false, 'error', 'already_member'); end if;
  if exists (select 1 from public.group_invites where group_id = p_group and invitee_id = p_invitee and status = 'pending') then return jsonb_build_object('ok', false, 'error', 'already_invited'); end if;
  if public.group_seats(p_group) >= 10 then return jsonb_build_object('ok', false, 'error', 'group_full'); end if;
  insert into public.group_invites (group_id, inviter_id, invitee_id, role)
  values (p_group, p_actor, p_invitee, case when p_role = 'viewer' then 'viewer' else 'editor' end) returning id into v_id;
  perform public.social_notify(p_invitee, 'group_invite', p_actor, null, null, jsonb_build_object('group_id', p_group, 'group_name', g.name));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 초대에 답하기 (받은 사람) → {ok, group_id}
create or replace function public.group_respond(p_user uuid, p_invite uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare i public.group_invites; g public.groups;
begin
  select * into i from public.group_invites where id = p_invite and invitee_id = p_user and status = 'pending' for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('group:' || i.group_id::text));
  select * into g from public.groups where id = i.group_id and deleted_at is null;
  if not found then
    update public.group_invites set status = 'canceled', responded_at = now() where id = p_invite;
    return jsonb_build_object('ok', false, 'error', 'group_gone');
  end if;
  if not p_accept then
    update public.group_invites set status = 'declined', responded_at = now() where id = p_invite;
    return jsonb_build_object('ok', true, 'group_id', i.group_id);
  end if;
  if (select count(*) from public.group_members m join public.groups gg on gg.id = m.group_id
       where m.user_id = p_user and gg.deleted_at is null) >= 5 then
    return jsonb_build_object('ok', false, 'error', 'group_limit');
  end if;
  if public.social_is_blocked(p_user, g.owner_id) then
    update public.group_invites set status = 'canceled', responded_at = now() where id = p_invite;
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into public.group_members (group_id, user_id, role) values (i.group_id, p_user, i.role) on conflict do nothing;
  update public.group_invites set status = 'accepted', responded_at = now() where id = p_invite;
  perform public.social_notify(g.owner_id, 'group_join', p_user, null, null, jsonb_build_object('group_id', g.id, 'group_name', g.name));
  return jsonb_build_object('ok', true, 'group_id', i.group_id);
end $$;

-- 역할 바꾸기 (모둠장만). p_role = 'owner' 이면 모둠장 넘기기(나는 editor 가 됨)
create or replace function public.group_set_role(p_actor uuid, p_group uuid, p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.groups;
begin
  perform pg_advisory_xact_lock(hashtext('group:' || p_group::text));
  select * into g from public.groups where id = p_group and deleted_at is null;
  if not found or g.owner_id <> p_actor then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  if p_user = p_actor or not exists (select 1 from public.group_members where group_id = p_group and user_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if p_role = 'owner' then
    update public.group_members set role = 'editor' where group_id = p_group and user_id = p_actor;
    update public.group_members set role = 'owner' where group_id = p_group and user_id = p_user;
    update public.groups set owner_id = p_user, updated_at = now() where id = p_group;
  elsif p_role in ('editor', 'viewer') then
    update public.group_members set role = p_role where group_id = p_group and user_id = p_user;
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;
  perform public.social_notify(p_user, 'group_role', p_actor, null, null, jsonb_build_object('group_id', g.id, 'group_name', g.name, 'role', p_role));
  return jsonb_build_object('ok', true);
end $$;

-- 내보내기(모둠장이 다른 사람) 또는 나가기(본인, 모둠장은 넘긴 뒤에만)
create or replace function public.group_remove(p_actor uuid, p_group uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.groups;
begin
  perform pg_advisory_xact_lock(hashtext('group:' || p_group::text));
  select * into g from public.groups where id = p_group and deleted_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_user = p_actor then
    if g.owner_id = p_actor then return jsonb_build_object('ok', false, 'error', 'owner_must_transfer'); end if;
  elsif g.owner_id <> p_actor then
    return jsonb_build_object('ok', false, 'error', 'not_owner');
  end if;
  delete from public.group_members where group_id = p_group and user_id = p_user and role <> 'owner';
  if not found then return jsonb_build_object('ok', false, 'error', 'not_member'); end if;
  if p_user <> p_actor then
    perform public.social_notify(p_user, 'group_removed', p_actor, null, null, jsonb_build_object('group_id', g.id, 'group_name', g.name));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 그룹 지우기 (모둠장만): 그룹은 삭제 표시, 그룹원·대기 초대 정리
create or replace function public.group_delete(p_actor uuid, p_group uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.groups set deleted_at = now(), updated_at = now() where id = p_group and owner_id = p_actor and deleted_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  update public.group_invites set status = 'canceled', responded_at = now() where group_id = p_group and status = 'pending';
  delete from public.group_members where group_id = p_group;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.group_seats(uuid) from public, anon, authenticated;
revoke execute on function public.group_create(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.group_invite(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.group_respond(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.group_set_role(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.group_remove(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.group_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.group_seats(uuid) to service_role;
grant execute on function public.group_create(uuid, text, text) to service_role;
grant execute on function public.group_invite(uuid, uuid, uuid, text) to service_role;
grant execute on function public.group_respond(uuid, uuid, boolean) to service_role;
grant execute on function public.group_set_role(uuid, uuid, uuid, text) to service_role;
grant execute on function public.group_remove(uuid, uuid, uuid) to service_role;
grant execute on function public.group_delete(uuid, uuid) to service_role;

commit;
