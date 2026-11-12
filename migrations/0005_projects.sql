-- 0005_projects.sql  (2단계-A: 계정 작업 저장 기반)
-- 선행: 0003_accounts.sql (profiles). 0004(자녀 프로필)는 없어도 된다 (child_id 는 FK 없이 두고 0004 적용 후 연결).
-- 모든 읽기·쓰기는 /api/projects, /api/assets (서버, service_role)가 JWT 로 소유자를 검증한 뒤 수행한다.
-- 적용 순서: 코드 배포 → 이 SQL 적용 (SQL 이 없으면 API 는 503 projects_not_ready 만 돌려주고 기존 기능에는 영향 없음)

begin;

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  child_id    uuid,                                   -- 자녀 프로필 작업 (0004 적용 후 FK 연결)
  kind        text not null check (kind in ('draw','story','character','storyboard','dub')),
  title       text not null default '' check (char_length(title) <= 100),
  data        jsonb not null default '{}'::jsonb,    -- 작은 설정·텍스트만. 이미지는 project_assets 로 참조
  thumb_asset uuid,
  version     int  not null default 1,
  size_bytes  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz                             -- 휴지통 (30일 뒤 영구 삭제)
);
create index if not exists projects_owner_idx on public.projects (owner_id, kind, updated_at desc);
create index if not exists projects_trash_idx on public.projects (deleted_at) where deleted_at is not null;

create table if not exists public.project_assets (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  path        text not null,
  mime        text not null,
  bytes       bigint not null check (bytes > 0 and bytes <= 10485760),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status      text not null default 'pending' check (status in ('pending','ready')),
  created_at  timestamptz not null default now(),
  unique (project_id, sha256)
);
create index if not exists project_assets_owner_idx on public.project_assets (owner_id);

create table if not exists public.project_versions (
  id          bigserial primary key,
  project_id  uuid not null references public.projects(id) on delete cascade,
  version     int  not null,
  title       text,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  unique (project_id, version)
);

create table if not exists public.user_quota (
  owner_id    uuid primary key references public.profiles(id) on delete cascade,
  bytes_used  bigint not null default 0 check (bytes_used >= 0),
  limit_bytes bigint not null default 524288000       -- 500MB
);

alter table public.projects         enable row level security;
alter table public.project_assets   enable row level security;
alter table public.project_versions enable row level security;
alter table public.user_quota       enable row level security;

-- 방어용: 본인 행 읽기만 허용 (쓰기는 서버 전용)
create policy projects_read_own  on public.projects       for select using (owner_id = auth.uid());
create policy assets_read_own    on public.project_assets for select using (owner_id = auth.uid());
create policy versions_read_own  on public.project_versions for select
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy quota_read_own     on public.user_quota     for select using (owner_id = auth.uid());

revoke all on public.projects, public.project_assets, public.project_versions, public.user_quota from anon, authenticated;
grant select on public.projects, public.project_assets, public.project_versions, public.user_quota to authenticated;

-- 용량 예약/반환 (원자적)
create or replace function public.reserve_quota(p_owner uuid, p_bytes bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_quota (owner_id) values (p_owner) on conflict do nothing;
  update public.user_quota set bytes_used = bytes_used + p_bytes
   where owner_id = p_owner and bytes_used + p_bytes <= limit_bytes;
  return found;
end $$;

create or replace function public.release_quota(p_owner uuid, p_bytes bigint) returns void
language sql security definer set search_path = public as $$
  update public.user_quota set bytes_used = greatest(0, bytes_used - p_bytes) where owner_id = p_owner;
$$;

-- 작업 저장: 버전 확인(충돌 방지) + 이전 버전 보관(최근 10개) 을 한 번에
-- 반환: 새 버전 번호 / -1 = 없음 / -2 = 충돌(다른 기기에서 먼저 저장됨)
create or replace function public.save_project(p_id uuid, p_owner uuid, p_expected int,
                                               p_title text, p_data jsonb, p_thumb uuid) returns int
language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  select version into cur from public.projects
   where id = p_id and owner_id = p_owner and deleted_at is null for update;
  if not found then return -1; end if;
  if cur <> p_expected then return -2; end if;
  insert into public.project_versions (project_id, version, title, data)
    select id, version, title, data from public.projects where id = p_id
    on conflict (project_id, version) do nothing;
  update public.projects
     set title = coalesce(p_title, title), data = p_data,
         thumb_asset = coalesce(p_thumb, thumb_asset),
         size_bytes = octet_length(p_data::text), version = cur + 1, updated_at = now()
   where id = p_id;
  delete from public.project_versions where project_id = p_id and version <= cur + 1 - 10;
  return cur + 1;
end $$;

revoke execute on function public.reserve_quota(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.release_quota(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.save_project(uuid, uuid, int, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.reserve_quota(uuid, bigint) to service_role;
grant execute on function public.release_quota(uuid, bigint) to service_role;
grant execute on function public.save_project(uuid, uuid, int, text, jsonb, uuid) to service_role;

-- 비공개 작업 파일 버킷 (정책 없음 = 서버가 발급한 서명 주소로만 읽기·쓰기)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-assets', 'user-assets', false, 10485760,
        array['image/png','image/jpeg','image/webp','image/gif','audio/mpeg','audio/wav','audio/webm'])
on conflict (id) do nothing;

commit;
