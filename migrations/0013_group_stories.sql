-- 0013_group_stories.sql  (4단계-B: 그룹 그림책 공동 제작 — 장면 나눠 맡기·잠금·제출·승인·버전·기여 기록)
-- 선행: 0005(reserve_quota/release_quota, user-assets 버킷), 0010(social_notify, notifications), 0012(groups, group_members)
-- 모든 접근은 서버(service_role)가 함수·REST 로 수행한다. 클라이언트 직접 접근 없음(RLS 켜고 정책 없음).
-- 장면 상태: open(아직 안 고침) → editing(잠금 중) → draft(임시본 있음, 잠금 풀림) → submitted(제출) → approved(완성본 반영) / returned(다시 요청)
-- 잠금: 맡은 사람(또는 모둠장)만, 10분. 잠금 중에만 임시본 저장. 모둠장은 잠금을 풀 수 있다.
-- 그림 파일은 user-assets 버킷 "<올린 사람>/groups/<작품>/..." 에 두고 올린 사람의 저장 용량에서 센다.

begin;

create table if not exists public.group_stories (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  mode        text not null default 'short' check (mode in ('short','long')),
  title       text not null check (char_length(title) between 1 and 60),
  common      jsonb not null default '{}'::jsonb,   -- {logline, charDesc, charRef(asset id), style, styleText, aspect}
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists group_stories_group on public.group_stories (group_id, created_at desc);

create table if not exists public.group_story_scenes (
  story_id       uuid not null references public.group_stories(id) on delete cascade,
  k              text not null check (char_length(k) between 1 and 40),
  ord            int not null,
  assignee_id    uuid references public.profiles(id) on delete set null,
  status         text not null default 'open' check (status in ('open','editing','draft','submitted','approved','returned')),
  draft          jsonb,                 -- {script, image(asset id)}
  final          jsonb,                 -- 완성본 {script, image}
  final_by       uuid references public.profiles(id) on delete set null,
  lock_user      uuid references public.profiles(id) on delete set null,
  lock_until     timestamptz,
  return_reason  text check (return_reason is null or char_length(return_reason) <= 300),
  updated_at     timestamptz not null default now(),
  primary key (story_id, k)
);
create index if not exists group_story_scenes_assignee on public.group_story_scenes (assignee_id);

create table if not exists public.group_story_versions (
  id          bigint generated always as identity primary key,
  story_id    uuid not null references public.group_stories(id) on delete cascade,
  n           int not null,
  snapshot    jsonb not null,           -- {title, common, scenes:[{k, ord, final, final_by}]}
  created_by  uuid references public.profiles(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (story_id, n)
);

create table if not exists public.group_story_activity (
  id          bigint generated always as identity primary key,
  story_id    uuid not null references public.group_stories(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  action      text not null,
  k           text,
  data        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists group_story_activity_story on public.group_story_activity (story_id, created_at desc);

create table if not exists public.group_story_assets (
  id           uuid primary key default gen_random_uuid(),
  story_id     uuid not null references public.group_stories(id) on delete cascade,
  uploader_id  uuid not null references public.profiles(id) on delete cascade,
  path         text not null unique,
  mime         text not null check (mime in ('image/png','image/jpeg','image/webp')),
  bytes        int not null check (bytes between 1 and 10485760),
  sha256       text not null,
  status       text not null default 'pending' check (status in ('pending','ready')),
  created_at   timestamptz not null default now(),
  unique (story_id, sha256)
);

alter table public.group_stories        enable row level security;
alter table public.group_story_scenes   enable row level security;
alter table public.group_story_versions enable row level security;
alter table public.group_story_activity enable row level security;
alter table public.group_story_assets   enable row level security;
revoke all on public.group_stories, public.group_story_scenes, public.group_story_versions, public.group_story_activity, public.group_story_assets from anon, authenticated;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed',
  'gs_assigned','gs_submitted','gs_approved','gs_returned'));

-- 이 사람의 작품 안 역할 (그룹원이 아니거나 작품이 지워졌으면 null)
create or replace function public.gs_role(p_user uuid, p_story uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from public.group_stories s
    join public.groups g on g.id = s.group_id and g.deleted_at is null
    join public.group_members m on m.group_id = s.group_id and m.user_id = p_user
   where s.id = p_story and s.deleted_at is null;
$$;

create or replace function public.gs_log(p_story uuid, p_user uuid, p_action text, p_k text, p_data jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.group_story_activity (story_id, user_id, action, k, data) values (p_story, p_user, p_action, p_k, p_data);
$$;

-- 지금 완성본을 버전으로 저장 (최근 20개만 보관)
create or replace function public.gs_snapshot(p_story uuid, p_user uuid, p_note text) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; s public.group_stories;
begin
  select * into s from public.group_stories where id = p_story;
  select coalesce(max(n), 0) + 1 into v_n from public.group_story_versions where story_id = p_story;
  insert into public.group_story_versions (story_id, n, snapshot, created_by, note)
  values (p_story, v_n, jsonb_build_object('title', s.title, 'common', s.common, 'scenes',
            coalesce((select jsonb_agg(jsonb_build_object('k', k, 'ord', ord, 'final', final, 'final_by', final_by) order by ord)
                        from public.group_story_scenes where story_id = p_story), '[]'::jsonb)),
          p_user, left(p_note, 100));
  delete from public.group_story_versions where story_id = p_story and n <= v_n - 20;
  return v_n;
end $$;

-- 작품 만들기 (모둠장). p_scenes: [{k, ord, script}] (가져오기면 글이 채워져 있음)
create or replace function public.gs_create(p_user uuid, p_group uuid, p_mode text, p_title text, p_common jsonb, p_scenes jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_n int;
begin
  if not exists (select 1 from public.groups g join public.group_members m on m.group_id = g.id
                  where g.id = p_group and g.deleted_at is null and m.user_id = p_user and m.role = 'owner') then
    return jsonb_build_object('ok', false, 'error', 'not_owner');
  end if;
  if public.social_active_sanction(p_user) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if (select count(*) from public.group_stories where group_id = p_group and deleted_at is null) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'story_limit');
  end if;
  v_n := jsonb_array_length(coalesce(p_scenes, '[]'::jsonb));
  if v_n < 1 or v_n > 41 then return jsonb_build_object('ok', false, 'error', 'invalid_scenes'); end if;
  insert into public.group_stories (group_id, mode, title, common, created_by)
  values (p_group, case when p_mode = 'long' then 'long' else 'short' end, p_title, coalesce(p_common, '{}'::jsonb), p_user) returning id into v_id;
  insert into public.group_story_scenes (story_id, k, ord, final)
  select v_id, x->>'k', (x->>'ord')::int,
         case when coalesce(x->>'script', '') <> '' then jsonb_build_object('script', left(x->>'script', 2000), 'image', null) end
    from jsonb_array_elements(p_scenes) x;
  perform public.gs_log(v_id, p_user, 'create', null, jsonb_build_object('scenes', v_n));
  perform public.gs_snapshot(v_id, p_user, '처음 만듦');
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 장면 맡기기. 모둠장: 누구에게나(만들기·모둠장 역할) 또는 비우기(null). 만들기 역할: 빈 장면을 스스로만
create or replace function public.gs_assign(p_actor uuid, p_story uuid, p_k text, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text; v_target_role text; sc public.group_story_scenes; s public.group_stories;
begin
  v_role := public.gs_role(p_actor, p_story);
  if v_role is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'error', 'no_permission'); end if;
  select * into sc from public.group_story_scenes where story_id = p_story and k = p_k for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_role <> 'owner' then
    if p_user is distinct from p_actor or sc.assignee_id is not null then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  end if;
  if p_user is not null then
    v_target_role := public.gs_role(p_user, p_story);
    if v_target_role is null or v_target_role = 'viewer' then return jsonb_build_object('ok', false, 'error', 'not_editor'); end if;
  end if;
  if sc.status = 'submitted' and p_user is distinct from sc.assignee_id then
    return jsonb_build_object('ok', false, 'error', 'submitted_wait');   -- 제출본은 승인·다시 요청 뒤에 바꾸기
  end if;
  update public.group_story_scenes
     set assignee_id = p_user, lock_user = null, lock_until = null,
         status = case when status in ('editing','returned','draft') and p_user is distinct from assignee_id then (case when final is null then 'open' else 'approved' end) else status end,
         draft = case when p_user is distinct from assignee_id then null else draft end,
         updated_at = now()
   where story_id = p_story and k = p_k;
  perform public.gs_log(p_story, p_actor, 'assign', p_k, jsonb_build_object('to', p_user));
  if p_user is not null and p_user <> p_actor then
    select * into s from public.group_stories where id = p_story;
    perform public.social_notify(p_user, 'gs_assigned', p_actor, null, null, jsonb_build_object('story_id', p_story, 'title', s.title, 'k', p_k, 'ord', sc.ord));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 편집 시작·연장 (잠금 10분). 처음 잠그면 완성본을 임시본으로 복사
create or replace function public.gs_lock(p_user uuid, p_story uuid, p_k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text; sc public.group_story_scenes; v_name text;
begin
  v_role := public.gs_role(p_user, p_story);
  if v_role is null or v_role = 'viewer' then return jsonb_build_object('ok', false, 'error', 'no_permission'); end if;
  if public.social_active_sanction(p_user) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  select * into sc from public.group_story_scenes where story_id = p_story and k = p_k for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if sc.assignee_id is distinct from p_user and v_role <> 'owner' then return jsonb_build_object('ok', false, 'error', 'not_assignee'); end if;
  if sc.status = 'submitted' then return jsonb_build_object('ok', false, 'error', 'submitted_wait'); end if;
  if sc.lock_user is not null and sc.lock_user <> p_user and sc.lock_until > now() then
    select nickname into v_name from public.profiles where id = sc.lock_user;
    return jsonb_build_object('ok', false, 'error', 'locked', 'by', v_name, 'until', sc.lock_until);
  end if;
  update public.group_story_scenes
     set lock_user = p_user, lock_until = now() + interval '10 minutes', status = 'editing',
         draft = coalesce(draft, final, jsonb_build_object('script', '', 'image', null)), updated_at = now()
   where story_id = p_story and k = p_k;
  if sc.lock_user is distinct from p_user or sc.lock_until is null or sc.lock_until <= now() then
    perform public.gs_log(p_story, p_user, 'lock', p_k, null);
  end if;
  return jsonb_build_object('ok', true, 'until', now() + interval '10 minutes');
end $$;

-- 편집 끝내기(본인) 또는 잠금 풀기(모둠장)
create or replace function public.gs_unlock(p_user uuid, p_story uuid, p_k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text; sc public.group_story_scenes;
begin
  v_role := public.gs_role(p_user, p_story);
  select * into sc from public.group_story_scenes where story_id = p_story and k = p_k for update;
  if not found or v_role is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if sc.lock_user is distinct from p_user and v_role <> 'owner' then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  update public.group_story_scenes
     set lock_user = null, lock_until = null,
         status = case when status = 'editing' then (case when draft is distinct from final then 'draft' else (case when final is null then 'open' else 'approved' end) end) else status end,
         updated_at = now()
   where story_id = p_story and k = p_k;
  -- 고친 내용(임시본)은 남겨 두고, 상태만 '편집 중'에서 벗어난다 (임시본이 있으면 'draft' = 고치는 중, 이어서 고치거나 제출 가능)
  perform public.gs_log(p_story, p_user, case when sc.lock_user = p_user then 'unlock' else 'force_unlock' end, p_k, null);
  return jsonb_build_object('ok', true);
end $$;

-- 임시본 저장 (잠금을 가진 사람만, 저장할 때마다 잠금 연장). p_draft = {script, image(asset id|null)}
create or replace function public.gs_save_draft(p_user uuid, p_story uuid, p_k text, p_draft jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sc public.group_story_scenes; v_img text;
begin
  select * into sc from public.group_story_scenes where story_id = p_story and k = p_k for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if sc.lock_user is distinct from p_user or sc.lock_until is null or sc.lock_until <= now() then
    return jsonb_build_object('ok', false, 'error', 'lock_lost');
  end if;
  v_img := nullif(p_draft->>'image', '');
  if v_img is not null and not exists (select 1 from public.group_story_assets where id::text = v_img and story_id = p_story and status = 'ready') then
    return jsonb_build_object('ok', false, 'error', 'invalid_image');
  end if;
  update public.group_story_scenes
     set draft = jsonb_build_object('script', left(coalesce(p_draft->>'script', ''), 2000), 'image', v_img),
         lock_until = now() + interval '10 minutes', updated_at = now()
   where story_id = p_story and k = p_k;
  return jsonb_build_object('ok', true);
end $$;

-- 제출 (맡은 사람). 모둠장이 자기 장면을 제출하면 바로 반영
create or replace function public.gs_submit(p_user uuid, p_story uuid, p_k text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_role text; sc public.group_story_scenes; s public.group_stories; g_owner uuid;
begin
  v_role := public.gs_role(p_user, p_story);
  select * into sc from public.group_story_scenes where story_id = p_story and k = p_k for update;
  if not found or v_role is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if sc.assignee_id is distinct from p_user and v_role <> 'owner' then return jsonb_build_object('ok', false, 'error', 'not_assignee'); end if;
  if sc.draft is null then return jsonb_build_object('ok', false, 'error', 'nothing_to_submit'); end if;
  select * into s from public.group_stories where id = p_story;
  if v_role = 'owner' then
    update public.group_story_scenes
       set final = draft, final_by = coalesce(assignee_id, p_user), draft = null, status = 'approved',
           lock_user = null, lock_until = null, return_reason = null, updated_at = now()
     where story_id = p_story and k = p_k;
    perform public.gs_log(p_story, p_user, 'approve', p_k, jsonb_build_object('self', true));
    perform public.gs_snapshot(p_story, p_user, '장면 반영');
    return jsonb_build_object('ok', true, 'status', 'approved');
  end if;
  update public.group_story_scenes
     set status = 'submitted', lock_user = null, lock_until = null, return_reason = null, updated_at = now()
   where story_id = p_story and k = p_k;
  perform public.gs_log(p_story, p_user, 'submit', p_k, null);
  select owner_id into g_owner from public.groups where id = s.group_id;
  perform public.social_notify(g_owner, 'gs_submitted', p_user, null, null, jsonb_build_object('story_id', p_story, 'title', s.title, 'k', p_k, 'ord', sc.ord));
  return jsonb_build_object('ok', true, 'status', 'submitted');
end $$;

-- 승인·다시 요청 (모둠장)
create or replace function public.gs_review(p_actor uuid, p_story uuid, p_k text, p_approve boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sc public.group_story_scenes; s public.group_stories;
begin
  if public.gs_role(p_actor, p_story) is distinct from 'owner' then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  select * into sc from public.group_story_scenes where story_id = p_story and k = p_k for update;
  if not found or sc.status <> 'submitted' then return jsonb_build_object('ok', false, 'error', 'not_submitted'); end if;
  select * into s from public.group_stories where id = p_story;
  if p_approve then
    update public.group_story_scenes
       set final = draft, final_by = assignee_id, draft = null, status = 'approved', return_reason = null, updated_at = now()
     where story_id = p_story and k = p_k;
    perform public.gs_log(p_story, p_actor, 'approve', p_k, jsonb_build_object('by', sc.assignee_id));
    perform public.gs_snapshot(p_story, p_actor, '장면 승인');
    perform public.social_notify(sc.assignee_id, 'gs_approved', p_actor, null, null, jsonb_build_object('story_id', p_story, 'title', s.title, 'k', p_k, 'ord', sc.ord));
  else
    if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
    update public.group_story_scenes set status = 'returned', return_reason = left(p_reason, 300), updated_at = now()
     where story_id = p_story and k = p_k;
    perform public.gs_log(p_story, p_actor, 'return', p_k, jsonb_build_object('reason', left(p_reason, 300)));
    perform public.social_notify(sc.assignee_id, 'gs_returned', p_actor, null, null, jsonb_build_object('story_id', p_story, 'title', s.title, 'k', p_k, 'ord', sc.ord, 'reason', left(p_reason, 300)));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 예전 버전으로 되돌리기 (모둠장): 그 버전의 제목·공통 설정·완성본을 되살리고 새 버전으로 기록
create or replace function public.gs_restore(p_actor uuid, p_story uuid, p_n int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; x jsonb;
begin
  if public.gs_role(p_actor, p_story) is distinct from 'owner' then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  select snapshot into v from public.group_story_versions where story_id = p_story and n = p_n;
  if v is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update public.group_stories set title = v->>'title', common = coalesce(v->'common', '{}'::jsonb), updated_at = now() where id = p_story;
  for x in select * from jsonb_array_elements(v->'scenes') loop
    update public.group_story_scenes set final = nullif(x->'final', 'null'::jsonb), final_by = nullif(x->>'final_by', '')::uuid, updated_at = now()
     where story_id = p_story and k = x->>'k';
  end loop;
  perform public.gs_log(p_story, p_actor, 'restore', null, jsonb_build_object('n', p_n));
  perform public.gs_snapshot(p_story, p_actor, p_n || '번 버전으로 되돌림');
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.gs_role(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.gs_log(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.gs_snapshot(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.gs_create(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.gs_assign(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.gs_lock(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.gs_unlock(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.gs_save_draft(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.gs_submit(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.gs_review(uuid, uuid, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.gs_restore(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.gs_role(uuid, uuid) to service_role;
grant execute on function public.gs_log(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.gs_snapshot(uuid, uuid, text) to service_role;
grant execute on function public.gs_create(uuid, uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.gs_assign(uuid, uuid, text, uuid) to service_role;
grant execute on function public.gs_lock(uuid, uuid, text) to service_role;
grant execute on function public.gs_unlock(uuid, uuid, text) to service_role;
grant execute on function public.gs_save_draft(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.gs_submit(uuid, uuid, text) to service_role;
grant execute on function public.gs_review(uuid, uuid, text, boolean, text) to service_role;
grant execute on function public.gs_restore(uuid, uuid, int) to service_role;

commit;
