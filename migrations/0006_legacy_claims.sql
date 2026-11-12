-- 0006_legacy_claims.sql  (2단계-B: 기존 비회원 저장(draw_saves)을 계정으로 이전)
-- 선행: 0003(profiles), 0005(projects)
-- 모든 접근은 /api/legacy (서버, service_role)가 수행한다. 클라이언트 직접 접근 없음.

begin;

-- 이전된 원본 표시 (다른 계정이 다시 가져가지 못하게 함)
alter table public.draw_saves
  add column if not exists claimed_by uuid references public.profiles(id) on delete set null,
  add column if not exists claimed_at timestamptz;

create table if not exists public.legacy_claims (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  source      text not null default 'draw_saves',
  source_id   uuid not null,
  project_id  uuid references public.projects(id) on delete set null,
  status      text not null check (status in ('started','done')),
  started_at  timestamptz not null default now(),
  done_at     timestamptz,
  unique (source, source_id)
);
create index if not exists legacy_claims_owner_idx on public.legacy_claims (owner_id);

-- 비밀번호 대입 시도 기록 (무차별 대입 방지)
create table if not exists public.claim_attempts (
  id            bigserial primary key,
  owner_id      uuid not null,
  key           text not null,          -- 시도한 저장 이름(소문자)
  ok            boolean not null,
  attempted_at  timestamptz not null default now()
);
create index if not exists claim_attempts_owner_idx on public.claim_attempts (owner_id, attempted_at desc);
create index if not exists claim_attempts_key_idx   on public.claim_attempts (key, attempted_at desc);

alter table public.legacy_claims  enable row level security;
alter table public.claim_attempts enable row level security;
revoke all on public.legacy_claims, public.claim_attempts from anon, authenticated;
-- 정책 없음 = 클라이언트 접근 불가 (서버만 사용)

commit;

-- ─────────────────────────────────────────────────────────────
-- 저장 함수 개선 (0005 의 save_project 교체): 이미지가 큰 작업에서 자동 저장이 잦아도 버전이 순식간에
-- 10개가 차서 복구 가능한 시간이 짧아지지 않도록, 직전 버전 보관 후 5분이 지나야 새 버전을 보관한다.
-- 보관 개수(최근 10개)는 번호가 아니라 최신 순으로 센다.
-- ─────────────────────────────────────────────────────────────
begin;
create or replace function public.save_project(p_id uuid, p_owner uuid, p_expected int,
                                               p_title text, p_data jsonb, p_thumb uuid) returns int
language plpgsql security definer set search_path = public as $$
declare cur int;
begin
  select version into cur from public.projects
   where id = p_id and owner_id = p_owner and deleted_at is null for update;
  if not found then return -1; end if;
  if cur <> p_expected then return -2; end if;
  if not exists (select 1 from public.project_versions
                  where project_id = p_id and created_at > now() - interval '5 minutes') then
    insert into public.project_versions (project_id, version, title, data)
      select id, version, title, data from public.projects where id = p_id
      on conflict (project_id, version) do nothing;
  end if;
  update public.projects
     set title = coalesce(p_title, title), data = p_data,
         thumb_asset = coalesce(p_thumb, thumb_asset),
         size_bytes = octet_length(p_data::text), version = cur + 1, updated_at = now()
   where id = p_id;
  delete from public.project_versions
   where project_id = p_id
     and id not in (select id from public.project_versions where project_id = p_id order by id desc limit 10);
  return cur + 1;
end $$;
revoke execute on function public.save_project(uuid, uuid, int, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_project(uuid, uuid, int, text, jsonb, uuid) to service_role;
commit;
