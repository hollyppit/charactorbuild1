-- 0014_group_publish.sql  (4단계-C: 그룹 작품 게시 — 함께 만든 사람 전원 동의 → 게시, 게시물에 함께 만든 사람 표시)
-- 선행: 0009(posts), 0010(social_notify, notifications), 0013(group_stories, group_story_scenes, group_story_versions)
-- 흐름: 모둠장 제안(pending, 지금 완성본 버전 n 기준) → 완성본에 장면이 반영된 그룹원(제안자 제외)에게 동의 요청
--       → 모두 동의(approved) → 모둠장이 그 버전 그림으로 게시 → 게시 완료(published) + 게시물에 함께 만든 사람 기록
--       한 명이라도 거절하면 declined, 7일 안에 다 모이지 않으면 expired. 함께 만든 사람은 게시 뒤 언제든 이름을 뺄 수 있다.

begin;

alter table public.posts add column if not exists group_story_id uuid references public.group_stories(id) on delete set null;

create table if not exists public.group_publish_requests (
  id             uuid primary key default gen_random_uuid(),
  story_id       uuid not null references public.group_stories(id) on delete cascade,
  proposer_id    uuid references public.profiles(id) on delete set null,
  version_n      int not null,
  title          text not null check (char_length(title) between 1 and 60),
  caption        text check (caption is null or char_length(caption) <= 500),
  visibility     text not null default 'public' check (visibility in ('public','followers')),
  comments_mode  text not null default 'all' check (comments_mode in ('all','followers','off')),
  status         text not null default 'pending' check (status in ('pending','approved','declined','expired','canceled','published')),
  post_id        uuid references public.posts(id) on delete set null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '7 days',
  decided_at     timestamptz
);
create index if not exists group_publish_requests_story on public.group_publish_requests (story_id, created_at desc);

create table if not exists public.group_publish_consents (
  request_id    uuid not null references public.group_publish_requests(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending','agreed','declined')),
  responded_at  timestamptz,
  primary key (request_id, user_id)
);
create index if not exists group_publish_consents_user on public.group_publish_consents (user_id, status);

create table if not exists public.post_credits (
  post_id   uuid not null references public.posts(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  role      text not null check (role in ('owner','contributor')),
  primary key (post_id, user_id)
);

alter table public.group_publish_requests enable row level security;
alter table public.group_publish_consents enable row level security;
alter table public.post_credits           enable row level security;
revoke all on public.group_publish_requests, public.group_publish_consents, public.post_credits from anon, authenticated;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed',
  'gs_assigned','gs_submitted','gs_approved','gs_returned',
  'gp_consent','gp_declined','gp_ready','gp_published'));

-- 게시 제안 (모둠장). 지금 완성본을 버전으로 남기고 그 버전을 기준으로 동의를 받는다
create or replace function public.gp_propose(p_actor uuid, p_story uuid, p_title text, p_caption text, p_visibility text, p_cmode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_req uuid; v_n int; s public.group_stories; v_cnt int; u uuid;
begin
  if public.gs_role(p_actor, p_story) is distinct from 'owner' then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  if public.social_active_sanction(p_actor) is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if not exists (select 1 from public.group_story_scenes where story_id = p_story and final is not null) then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_publish');
  end if;
  select * into s from public.group_stories where id = p_story;
  -- 이전 제안 중 끝나지 않은 것은 취소
  update public.group_publish_requests set status = 'canceled', decided_at = now() where story_id = p_story and status in ('pending','approved');
  v_n := public.gs_snapshot(p_story, p_actor, '게시 제안');
  insert into public.group_publish_requests (story_id, proposer_id, version_n, title, caption, visibility, comments_mode)
  values (p_story, p_actor, v_n, p_title, nullif(p_caption, ''),
          case when p_visibility = 'followers' then 'followers' else 'public' end,
          case when p_cmode in ('followers','off') then p_cmode else 'all' end)
  returning id into v_req;
  insert into public.group_publish_consents (request_id, user_id)
  select distinct v_req, final_by from public.group_story_scenes
   where story_id = p_story and final is not null and final_by is not null and final_by <> p_actor;
  get diagnostics v_cnt = row_count;
  if v_cnt = 0 then
    update public.group_publish_requests set status = 'approved', decided_at = now() where id = v_req;
    return jsonb_build_object('ok', true, 'id', v_req, 'status', 'approved', 'version', v_n);
  end if;
  for u in select user_id from public.group_publish_consents where request_id = v_req loop
    perform public.social_notify(u, 'gp_consent', p_actor, null, null, jsonb_build_object('request_id', v_req, 'story_id', p_story, 'title', p_title));
  end loop;
  perform public.gs_log(p_story, p_actor, 'propose', null, jsonb_build_object('request_id', v_req, 'consents', v_cnt));
  return jsonb_build_object('ok', true, 'id', v_req, 'status', 'pending', 'version', v_n, 'consents', v_cnt);
end $$;

-- 동의·거절 (함께 만든 사람). 그룹을 나갔어도 동의 목록에 있으면 답할 수 있다
create or replace function public.gp_respond(p_user uuid, p_request uuid, p_agree boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.group_publish_requests;
begin
  select * into r from public.group_publish_requests where id = p_request for update;
  if not found or not exists (select 1 from public.group_publish_consents where request_id = p_request and user_id = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if r.status = 'pending' and r.expires_at < now() then
    update public.group_publish_requests set status = 'expired', decided_at = now() where id = p_request;
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'not_pending', 'status', r.status); end if;
  update public.group_publish_consents set status = case when p_agree then 'agreed' else 'declined' end, responded_at = now()
   where request_id = p_request and user_id = p_user;
  perform public.gs_log(r.story_id, p_user, case when p_agree then 'consent' else 'decline' end, null, jsonb_build_object('request_id', p_request));
  if not p_agree then
    update public.group_publish_requests set status = 'declined', decided_at = now() where id = p_request;
    perform public.social_notify(r.proposer_id, 'gp_declined', p_user, null, null, jsonb_build_object('request_id', p_request, 'story_id', r.story_id, 'title', r.title));
    return jsonb_build_object('ok', true, 'status', 'declined');
  end if;
  if not exists (select 1 from public.group_publish_consents where request_id = p_request and status <> 'agreed') then
    update public.group_publish_requests set status = 'approved', decided_at = now() where id = p_request;
    perform public.social_notify(r.proposer_id, 'gp_ready', p_user, null, null, jsonb_build_object('request_id', p_request, 'story_id', r.story_id, 'title', r.title));
    return jsonb_build_object('ok', true, 'status', 'approved');
  end if;
  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;

-- 게시 완료 기록 (서버가 게시물을 만든 뒤 호출): 게시물에 그룹 작품·함께 만든 사람을 잇고 알림
create or replace function public.gp_complete(p_actor uuid, p_request uuid, p_post uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.group_publish_requests; u uuid;
begin
  select * into r from public.group_publish_requests where id = p_request for update;
  if not found or r.proposer_id is distinct from p_actor or r.status <> 'approved' then return jsonb_build_object('ok', false, 'error', 'not_ready'); end if;
  if not exists (select 1 from public.posts where id = p_post and owner_id = p_actor) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  update public.group_publish_requests set status = 'published', post_id = p_post, decided_at = now() where id = p_request;
  update public.posts set group_story_id = r.story_id where id = p_post;
  insert into public.post_credits (post_id, user_id, role) values (p_post, p_actor, 'owner') on conflict do nothing;
  insert into public.post_credits (post_id, user_id, role)
  select p_post, user_id, 'contributor' from public.group_publish_consents where request_id = p_request and status = 'agreed'
  on conflict do nothing;
  for u in select user_id from public.group_publish_consents where request_id = p_request and status = 'agreed' loop
    perform public.social_notify(u, 'gp_published', p_actor, p_post, null, jsonb_build_object('story_id', r.story_id, 'title', r.title));
  end loop;
  perform public.gs_log(r.story_id, p_actor, 'publish', null, jsonb_build_object('post_id', p_post));
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.gp_propose(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.gp_respond(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.gp_complete(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.gp_propose(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.gp_respond(uuid, uuid, boolean) to service_role;
grant execute on function public.gp_complete(uuid, uuid, uuid) to service_role;

commit;
