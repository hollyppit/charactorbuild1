-- 0009_social_posts.sql  (3단계-A: 작품 게시·공개 프로필·신고·제재)
-- 선행: 0003(profiles), 0005(projects, reserve_quota/release_quota)
-- 모든 접근은 서버(Cloudflare Functions, service_role)가 수행한다. 클라이언트 직접 접근 없음(RLS 켜고 정책 없음).
-- 게시 그림은 비공개 버킷 post-media 에 두고, 서버가 보여 줄 수 있는 게시물에 한해 짧은 서명 주소를 발급한다
-- (숨김·삭제된 게시물 그림은 주소가 만료되면 더 볼 수 없음).
-- 게시물 상태: uploading(그림 올리는 중) → pending(관리자 확인 대기) 또는 published(공개)
--             → hidden(신고 누적·관리자 숨김) / rejected(승인 거절) / deleted(삭제)

begin;

create table if not exists public.social_settings (
  id                  int primary key default 1 check (id = 1),
  require_approval    boolean not null default true,   -- true = 관리자 승인 후 공개
  auto_hide_reports   int not null default 3  check (auto_hide_reports between 1 and 100),
  daily_post_limit    int not null default 20 check (daily_post_limit between 0 and 1000),
  daily_report_limit  int not null default 20 check (daily_report_limit between 0 and 1000),
  updated_at          timestamptz not null default now()
);
insert into public.social_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.posts (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references public.profiles(id) on delete cascade,
  kind               text not null check (kind in ('draw','character','storyboard','story','dub')),
  title              text not null check (char_length(title) between 1 and 60),
  caption            text check (caption is null or char_length(caption) <= 500),
  visibility         text not null default 'public' check (visibility in ('public','followers')),
  status             text not null default 'uploading'
                     check (status in ('uploading','pending','published','hidden','rejected','deleted')),
  status_reason      text check (status_reason is null or char_length(status_reason) <= 500),
  source_project_id  uuid references public.projects(id) on delete set null,
  replaces_post_id   uuid,
  media_count        int not null default 0,
  bytes              bigint not null default 0,
  report_count       int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  published_at       timestamptz,
  reviewed_at        timestamptz
);
create index if not exists posts_feed on public.posts (status, visibility, published_at desc);
create index if not exists posts_owner on public.posts (owner_id, created_at desc);
create index if not exists posts_project on public.posts (source_project_id);

create table if not exists public.post_media (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  idx         int not null check (idx between 0 and 19),
  path        text not null unique,
  mime        text not null check (mime in ('image/png','image/jpeg','image/webp')),
  bytes       int not null check (bytes between 1 and 10485760),
  width       int check (width is null or width between 1 and 10000),
  height      int check (height is null or height between 1 and 10000),
  sha256      text not null,
  body        text check (body is null or char_length(body) <= 1000),   -- 장면 글(스토리)
  status      text not null default 'pending' check (status in ('pending','ready')),
  unique (post_id, idx)
);

create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid references public.profiles(id) on delete set null,
  target_type   text not null check (target_type in ('post','profile')),
  target_id     uuid not null,
  target_owner  uuid references public.profiles(id) on delete set null,
  reason        text not null check (reason in ('inappropriate','bullying','privacy','copyright','spam','other')),
  detail        text check (detail is null or char_length(detail) <= 500),
  status        text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution    text check (resolution is null or char_length(resolution) <= 500),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  unique (reporter_id, target_type, target_id)
);
create index if not exists reports_open on public.reports (status, created_at desc);
create index if not exists reports_target on public.reports (target_type, target_id);
create index if not exists reports_reporter_day on public.reports (reporter_id, created_at);

create table if not exists public.sanctions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('warning','post_ban','suspend')),
  reason      text not null check (char_length(reason) between 1 and 500),
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,                -- null = 기한 없음(해제할 때까지). 경고는 기록만
  revoked_at  timestamptz,
  report_id   uuid references public.reports(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists sanctions_user on public.sanctions (user_id, created_at desc);

alter table public.social_settings enable row level security;
alter table public.posts           enable row level security;
alter table public.post_media      enable row level security;
alter table public.reports         enable row level security;
alter table public.sanctions       enable row level security;
revoke all on public.social_settings, public.posts, public.post_media, public.reports, public.sanctions from anon, authenticated;

-- 지금 효력이 있는 제재 중 가장 무거운 것 (이용 정지 > 게시 금지). 없으면 null
create or replace function public.social_active_sanction(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(s) - 'report_id' from public.sanctions s
   where s.user_id = p_user and s.kind in ('post_ban','suspend') and s.revoked_at is null
     and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())
   order by (s.kind = 'suspend') desc, s.ends_at desc nulls first
   limit 1;
$$;

-- 게시 시작: 제재·하루 개수·용량 확인 후 게시물과 그림 자리(경로)를 만든다.
-- p_media: [{idx, path, mime, bytes, width, height, sha256, body}]  (경로는 서버가 만든다)
-- 반환: {ok:true, id, stale_paths:[...]} 또는 {ok:false, error}
create or replace function public.social_begin_post(p_owner uuid, p_id uuid, p_kind text, p_title text, p_caption text,
                                                    p_visibility text, p_project uuid, p_replaces uuid, p_media jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.social_settings;
  v_sanction jsonb;
  v_today_cnt int;
  v_bytes bigint;
  v_n int;
  v_stale text[] := '{}';
  v_stale_bytes bigint := 0;
  r record;
begin
  perform pg_advisory_xact_lock(hashtext('post:' || p_owner::text));
  select * into st from public.social_settings where id = 1;

  v_sanction := public.social_active_sanction(p_owner);
  if v_sanction is not null then
    return jsonb_build_object('ok', false, 'error', 'sanctioned', 'sanction', v_sanction);
  end if;

  -- 1시간 넘게 "올리는 중"으로 남은 내 게시물 정리 (그림 경로는 서버가 저장소에서 지움)
  for r in select id, bytes from public.posts where owner_id = p_owner and status = 'uploading' and created_at < now() - interval '1 hour' loop
    v_stale := v_stale || coalesce((select array_agg(path) from public.post_media where post_id = r.id), '{}');
    v_stale_bytes := v_stale_bytes + r.bytes;
    delete from public.posts where id = r.id;
  end loop;
  if v_stale_bytes > 0 then perform public.release_quota(p_owner, v_stale_bytes); end if;

  select count(*) into v_today_cnt from public.posts
   where owner_id = p_owner and created_at >= ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul');
  if v_today_cnt >= st.daily_post_limit then
    return jsonb_build_object('ok', false, 'error', 'daily_post_limit', 'limit', st.daily_post_limit, 'stale_paths', to_jsonb(v_stale));
  end if;

  v_n := jsonb_array_length(coalesce(p_media, '[]'::jsonb));
  if v_n < 1 or v_n > 20 then return jsonb_build_object('ok', false, 'error', 'invalid_media', 'stale_paths', to_jsonb(v_stale)); end if;
  select coalesce(sum((m->>'bytes')::bigint), 0) into v_bytes from jsonb_array_elements(p_media) m;

  if p_project is not null and not exists (select 1 from public.projects where id = p_project and owner_id = p_owner) then
    p_project := null;
  end if;
  if p_replaces is not null and not exists (select 1 from public.posts where id = p_replaces and owner_id = p_owner and status <> 'deleted') then
    p_replaces := null;
  end if;

  if not public.reserve_quota(p_owner, v_bytes) then
    return jsonb_build_object('ok', false, 'error', 'quota_exceeded', 'stale_paths', to_jsonb(v_stale));
  end if;

  insert into public.posts (id, owner_id, kind, title, caption, visibility, source_project_id, replaces_post_id, media_count, bytes)
  values (p_id, p_owner, p_kind, p_title, nullif(p_caption, ''), p_visibility, p_project, p_replaces, v_n, v_bytes);

  insert into public.post_media (post_id, owner_id, idx, path, mime, bytes, width, height, sha256, body)
  select p_id, p_owner, (m->>'idx')::int, m->>'path', m->>'mime', (m->>'bytes')::int,
         nullif(m->>'width', '')::int, nullif(m->>'height', '')::int, m->>'sha256', nullif(m->>'body', '')
    from jsonb_array_elements(p_media) m;

  return jsonb_build_object('ok', true, 'id', p_id, 'stale_paths', to_jsonb(v_stale));
end $$;

-- 게시 마무리: 서버가 모든 그림 업로드(크기)를 확인한 뒤 호출. 설정에 따라 확인 대기 또는 공개.
-- 바꿔 게시(p_replaces)면 이전 게시물을 삭제 처리하고 그 그림 경로를 돌려준다(서버가 저장소에서 지움).
create or replace function public.social_finish_post(p_owner uuid, p_post uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.social_settings;
  p public.posts;
  v_status text;
  v_old_paths text[] := '{}';
  v_old_bytes bigint := 0;
begin
  select * into st from public.social_settings where id = 1;
  select * into p from public.posts where id = p_post and owner_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p.status <> 'uploading' then return jsonb_build_object('ok', true, 'status', p.status, 'old_paths', '[]'::jsonb); end if;

  update public.post_media set status = 'ready' where post_id = p_post;
  v_status := case when st.require_approval then 'pending' else 'published' end;
  update public.posts set status = v_status, updated_at = now(),
         published_at = case when v_status = 'published' then now() else null end
   where id = p_post;

  if p.replaces_post_id is not null then
    select coalesce(array_agg(path), '{}') into v_old_paths from public.post_media where post_id = p.replaces_post_id;
    select bytes into v_old_bytes from public.posts where id = p.replaces_post_id and owner_id = p_owner and status <> 'deleted';
    update public.posts set status = 'deleted', updated_at = now() where id = p.replaces_post_id and owner_id = p_owner;
    delete from public.post_media where post_id = p.replaces_post_id;
    if coalesce(v_old_bytes, 0) > 0 then
      perform public.release_quota(p_owner, v_old_bytes);
      update public.posts set bytes = 0 where id = p.replaces_post_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'status', v_status, 'old_paths', to_jsonb(v_old_paths));
end $$;

-- 게시물 삭제(본인 또는 관리자). 그림 경로를 돌려준다(서버가 저장소에서 지움). 용량 반환.
create or replace function public.social_delete_post(p_post uuid, p_owner uuid, p_admin boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.posts;
  v_paths text[];
begin
  select * into p from public.posts where id = p_post for update;
  if not found or p.status = 'deleted' or (not coalesce(p_admin, false) and p.owner_id is distinct from p_owner) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select coalesce(array_agg(path), '{}') into v_paths from public.post_media where post_id = p_post;
  delete from public.post_media where post_id = p_post;
  update public.posts set status = 'deleted', bytes = 0, updated_at = now() where id = p_post;
  if p.bytes > 0 then perform public.release_quota(p.owner_id, p.bytes); end if;
  return jsonb_build_object('ok', true, 'paths', to_jsonb(v_paths));
end $$;

-- 신고: 하루 개수 확인, 자기 자신 신고 금지, 같은 대상 중복 신고는 한 번만.
-- 게시물 신고가 서로 다른 사람 N명(설정)에 이르면 자동 숨김(관리자 검토 대기).
create or replace function public.social_report(p_reporter uuid, p_type text, p_target uuid, p_reason text, p_detail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.social_settings;
  v_owner uuid;
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
  else
    return jsonb_build_object('ok', false, 'error', 'invalid_target');
  end if;
  if v_owner is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_owner = p_reporter then return jsonb_build_object('ok', false, 'error', 'self_report'); end if;

  insert into public.reports (reporter_id, target_type, target_id, target_owner, reason, detail)
  values (p_reporter, p_type, p_target, v_owner, p_reason, nullif(left(coalesce(p_detail, ''), 500), ''))
  on conflict (reporter_id, target_type, target_id) do nothing;
  if not found then return jsonb_build_object('ok', true, 'already', true); end if;

  if p_type = 'post' then
    select count(distinct reporter_id) into v_cnt from public.reports
     where target_type = 'post' and target_id = p_target and status = 'open';
    update public.posts set report_count = v_cnt where id = p_target;
    if v_cnt >= st.auto_hide_reports then
      update public.posts set status = 'hidden', status_reason = 'auto_hidden', updated_at = now()
       where id = p_target and status = 'published';
      v_hidden := found;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'hidden', v_hidden);
end $$;

revoke execute on function public.social_active_sanction(uuid) from public, anon, authenticated;
revoke execute on function public.social_begin_post(uuid, uuid, text, text, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.social_finish_post(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_delete_post(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.social_report(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.social_active_sanction(uuid) to service_role;
grant execute on function public.social_begin_post(uuid, uuid, text, text, text, text, uuid, uuid, jsonb) to service_role;
grant execute on function public.social_finish_post(uuid, uuid) to service_role;
grant execute on function public.social_delete_post(uuid, uuid, boolean) to service_role;
grant execute on function public.social_report(uuid, text, uuid, text, text) to service_role;

-- 게시 그림 버킷 (비공개 · 정책 없음 = 서버가 발급한 서명 주소로만 읽기·쓰기)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-media', 'post-media', false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

commit;
