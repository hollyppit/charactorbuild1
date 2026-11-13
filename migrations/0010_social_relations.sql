-- 0010_social_relations.sql  (3단계-B: 팔로우·팔로워 공개·좋아요·댓글·차단·알림)
-- 선행: 0009(posts, reports, sanctions, social_settings, social_active_sanction)
-- 모든 접근은 서버(service_role)가 함수·REST 로 수행한다. 클라이언트 직접 접근 없음(RLS 켜고 정책 없음).
-- 팔로우: 상대 프로필이 전체 공개면 바로 accepted, 아니면 pending(상대가 수락).
-- 차단: 서로 팔로우를 끊고, 서로의 게시물·댓글·프로필을 숨기며, 팔로우·댓글·좋아요를 막는다.
-- 댓글: 300자, 1시간 30개, 게시물별 all/followers/off, 신고 N명이면 자동 가림. 알림은 90일 보관.

begin;

alter table public.posts
  add column if not exists like_count    int not null default 0,
  add column if not exists comment_count int not null default 0,
  add column if not exists comments_mode text not null default 'all';
do $$ begin
  alter table public.posts add constraint posts_comments_mode_check check (comments_mode in ('all','followers','off'));
exception when duplicate_object then null; end $$;

alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('post','profile','comment'));

alter table public.social_settings add column if not exists hourly_comment_limit int not null default 30;

create table if not exists public.follows (
  follower_id  uuid not null references public.profiles(id) on delete cascade,
  followee_id  uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_followee on public.follows (followee_id, status);

create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles(id) on delete cascade,
  blocked_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked on public.blocks (blocked_id);

create table if not exists public.likes (
  post_id     uuid not null references public.posts(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists likes_user on public.likes (user_id);

create table if not exists public.comments (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references public.posts(id) on delete cascade,
  author_id      uuid not null references public.profiles(id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 300),
  status         text not null default 'visible' check (status in ('visible','hidden','deleted')),
  status_reason  text check (status_reason is null or char_length(status_reason) <= 500),
  report_count   int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists comments_post on public.comments (post_id, created_at);
create index if not exists comments_author on public.comments (author_id, created_at desc);

create table if not exists public.notifications (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null check (type in ('follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed','comment_hidden','sanction')),
  actor_id    uuid references public.profiles(id) on delete cascade,
  post_id     uuid references public.posts(id) on delete cascade,
  comment_id  uuid references public.comments(id) on delete cascade,
  data        jsonb,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user on public.notifications (user_id, created_at desc);
create index if not exists notifications_created on public.notifications (created_at);

alter table public.follows       enable row level security;
alter table public.blocks        enable row level security;
alter table public.likes         enable row level security;
alter table public.comments      enable row level security;
alter table public.notifications enable row level security;
revoke all on public.follows, public.blocks, public.likes, public.comments, public.notifications from anon, authenticated;

-- 둘 사이에 차단이 있는지 (어느 쪽이든)
create or replace function public.social_is_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and exists (
    select 1 from public.blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;

-- 보는 사람이 이 게시물을 볼 수 있는지 (공개 게시물·팔로워 게시물·내 게시물, 차단 제외)
create or replace function public.social_can_view_post(p_viewer uuid, p_post uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.posts p
     where p.id = p_post and p.status = 'published'
       and not public.social_is_blocked(p_viewer, p.owner_id)
       and (p.visibility = 'public' or p.owner_id = p_viewer
            or exists (select 1 from public.follows f where f.follower_id = p_viewer and f.followee_id = p.owner_id and f.status = 'accepted')));
$$;

-- 알림 넣기 (자기 자신·차단 관계면 넣지 않음). 90일 지난 알림은 조금씩 정리
create or replace function public.social_notify(p_user uuid, p_type text, p_actor uuid, p_post uuid, p_comment uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = p_actor or public.social_is_blocked(p_user, p_actor) then return; end if;
  insert into public.notifications (user_id, type, actor_id, post_id, comment_id, data)
  values (p_user, p_type, p_actor, p_post, p_comment, p_data);
  if random() < 0.05 then
    delete from public.notifications where id in (
      select id from public.notifications where created_at < now() - interval '90 days' order by id limit 200);
  end if;
end $$;

-- 팔로우하기: 결과 {ok, status:'accepted'|'pending'} 또는 {ok:false, error}
create or replace function public.social_follow(p_follower uuid, p_followee uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_vis text; v_status text; v_existing text;
begin
  if p_follower = p_followee then return jsonb_build_object('ok', false, 'error', 'self'); end if;
  select visibility into v_vis from public.profiles where id = p_followee;
  if v_vis is null or public.social_is_blocked(p_follower, p_followee) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select status into v_existing from public.follows where follower_id = p_follower and followee_id = p_followee;
  if v_existing is not null then return jsonb_build_object('ok', true, 'status', v_existing); end if;
  v_status := case when v_vis = 'public' then 'accepted' else 'pending' end;
  insert into public.follows (follower_id, followee_id, status, accepted_at)
  values (p_follower, p_followee, v_status, case when v_status = 'accepted' then now() end);
  perform public.social_notify(p_followee, case when v_status = 'accepted' then 'follow' else 'follow_request' end, p_follower, null, null, null);
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

-- 팔로우 요청 수락·거절 (받은 사람이 호출)
create or replace function public.social_follow_respond(p_followee uuid, p_follower uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_accept then
    update public.follows set status = 'accepted', accepted_at = now()
     where follower_id = p_follower and followee_id = p_followee and status = 'pending';
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    perform public.social_notify(p_follower, 'follow_accept', p_followee, null, null, null);
  else
    delete from public.follows where follower_id = p_follower and followee_id = p_followee and status = 'pending';
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- 차단: 서로 팔로우 끊기
create or replace function public.social_block(p_blocker uuid, p_blocked uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_blocker = p_blocked or not exists (select 1 from public.profiles where id = p_blocked) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into public.blocks (blocker_id, blocked_id) values (p_blocker, p_blocked) on conflict do nothing;
  delete from public.follows where (follower_id = p_blocker and followee_id = p_blocked) or (follower_id = p_blocked and followee_id = p_blocker);
  return jsonb_build_object('ok', true);
end $$;

-- 좋아요 켜기·끄기. 결과 {ok, liked, like_count}
create or replace function public.social_like(p_user uuid, p_post uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_cnt int; v_new boolean := false;
begin
  perform pg_advisory_xact_lock(hashtext('like:' || p_post::text));
  if p_on then
    if not public.social_can_view_post(p_user, p_post) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    insert into public.likes (post_id, user_id) values (p_post, p_user) on conflict do nothing;
    v_new := found;
  else
    delete from public.likes where post_id = p_post and user_id = p_user;
  end if;
  select count(*) into v_cnt from public.likes where post_id = p_post;
  update public.posts set like_count = v_cnt where id = p_post returning owner_id into v_owner;
  if v_new and not exists (select 1 from public.notifications where user_id = v_owner and type = 'like' and actor_id = p_user and post_id = p_post) then
    perform public.social_notify(v_owner, 'like', p_user, p_post, null, null);
  end if;
  return jsonb_build_object('ok', true, 'liked', p_on, 'like_count', v_cnt);
end $$;

-- 댓글 쓰기. 결과 {ok, id} 또는 {ok:false, error}
create or replace function public.social_comment(p_user uuid, p_post uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.posts; st public.social_settings; v_cnt int; v_id uuid; v_sanction jsonb;
begin
  select * into st from public.social_settings where id = 1;
  v_sanction := public.social_active_sanction(p_user);
  if v_sanction is not null then return jsonb_build_object('ok', false, 'error', 'sanctioned'); end if;
  if not public.social_can_view_post(p_user, p_post) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into p from public.posts where id = p_post;
  if p.comments_mode = 'off' then return jsonb_build_object('ok', false, 'error', 'comments_off'); end if;
  if p.comments_mode = 'followers' and p.owner_id <> p_user and not exists (
       select 1 from public.follows where follower_id = p_user and followee_id = p.owner_id and status = 'accepted') then
    return jsonb_build_object('ok', false, 'error', 'followers_only');
  end if;
  perform pg_advisory_xact_lock(hashtext('comment:' || p_user::text));
  select count(*) into v_cnt from public.comments where author_id = p_user and created_at > now() - interval '1 hour';
  if v_cnt >= st.hourly_comment_limit then return jsonb_build_object('ok', false, 'error', 'comment_limit'); end if;
  insert into public.comments (post_id, author_id, body) values (p_post, p_user, p_body) returning id into v_id;
  update public.posts set comment_count = (select count(*) from public.comments where post_id = p_post and status = 'visible') where id = p_post;
  perform public.social_notify(p.owner_id, 'comment', p_user, p_post, v_id, jsonb_build_object('preview', left(p_body, 60)));
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 댓글 지우기 (쓴 사람·게시물 주인·관리자)
create or replace function public.social_delete_comment(p_actor uuid, p_comment uuid, p_admin boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.comments; v_owner uuid;
begin
  select * into c from public.comments where id = p_comment and status <> 'deleted';
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select owner_id into v_owner from public.posts where id = c.post_id;
  if not coalesce(p_admin, false) and p_actor is distinct from c.author_id and p_actor is distinct from v_owner then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  update public.comments set status = 'deleted', updated_at = now() where id = p_comment;
  update public.posts set comment_count = (select count(*) from public.comments where post_id = c.post_id and status = 'visible') where id = c.post_id;
  return jsonb_build_object('ok', true);
end $$;

-- 신고: 0009 함수를 댓글까지 넓힘 (댓글은 서로 다른 신고자 N명이면 자동 가림)
create or replace function public.social_report(p_reporter uuid, p_type text, p_target uuid, p_reason text, p_detail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.social_settings;
  v_owner uuid;
  v_post uuid;
  v_cnt int;
  v_today int;
  v_hidden boolean := false;
begin
  select * into st from public.social_settings where id = 1;
  perform pg_advisory_xact_lock(hashtext('report:' || p_target::text));

  select count(*) into v_today from public.reports
   where reporter_id = p_reporter and created_at >= ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul');
  if v_today >= st.daily_report_limit then return jsonb_build_object('ok', false, 'error', 'daily_report_limit'); end if;

  if p_type = 'post' then
    select owner_id into v_owner from public.posts where id = p_target and status in ('published','hidden','pending');
  elsif p_type = 'profile' then
    select id into v_owner from public.profiles where id = p_target;
  elsif p_type = 'comment' then
    select author_id, post_id into v_owner, v_post from public.comments where id = p_target and status in ('visible','hidden');
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_owner = p_reporter then return jsonb_build_object('ok', false, 'error', 'self_report'); end if;

  insert into public.reports (reporter_id, target_type, target_id, target_owner, reason, detail)
  values (p_reporter, p_type, p_target, v_owner, p_reason, nullif(left(coalesce(p_detail, ''), 500), ''))
  on conflict (reporter_id, target_type, target_id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'already', true); end if;

  if p_type in ('post', 'comment') then
    select count(distinct reporter_id) into v_cnt from public.reports
     where target_type = p_type and target_id = p_target and status = 'open';
    if p_type = 'post' then
      update public.posts set report_count = v_cnt where id = p_target;
      if v_cnt >= st.auto_hide_reports then
        update public.posts set status = 'hidden', status_reason = 'auto_hidden', updated_at = now()
         where id = p_target and status = 'published';
        v_hidden := found;
      end if;
    else
      update public.comments set report_count = v_cnt where id = p_target;
      if v_cnt >= st.auto_hide_reports then
        update public.comments set status = 'hidden', status_reason = 'auto_hidden', updated_at = now()
         where id = p_target and status = 'visible';
        v_hidden := found;
        if v_hidden then
          update public.posts set comment_count = (select count(*) from public.comments where post_id = v_post and status = 'visible') where id = v_post;
        end if;
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'hidden', v_hidden);
end $$;

revoke execute on function public.social_is_blocked(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_can_view_post(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_notify(uuid, text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.social_follow(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_follow_respond(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.social_block(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_like(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.social_comment(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.social_delete_comment(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.social_report(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.social_is_blocked(uuid, uuid) to service_role;
grant execute on function public.social_can_view_post(uuid, uuid) to service_role;
grant execute on function public.social_notify(uuid, text, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.social_follow(uuid, uuid) to service_role;
grant execute on function public.social_follow_respond(uuid, uuid, boolean) to service_role;
grant execute on function public.social_block(uuid, uuid) to service_role;
grant execute on function public.social_like(uuid, uuid, boolean) to service_role;
grant execute on function public.social_comment(uuid, uuid, text) to service_role;
grant execute on function public.social_delete_comment(uuid, uuid, boolean) to service_role;
grant execute on function public.social_report(uuid, text, uuid, text, text) to service_role;

commit;
