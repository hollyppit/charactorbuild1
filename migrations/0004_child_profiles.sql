-- 0004_child_profiles.sql  (1단계-A2: 보호자 계정 아래 아동 프로필)
-- 선행: 0003_accounts.sql (profiles 테이블) 적용 완료
-- 아동은 Supabase Auth 계정을 갖지 않는다. 보호자(profiles) 아래의 "프로필" 행으로만 존재한다.
-- 쓰기는 모두 /api/children (서버, service_role) 에서 검증 후 수행한다.
-- (2026-11-15 정비 — 아직 운영 DB 미적용: PIN 틀림 잠금 칸, 앱 직접 읽기 권한 제거, projects.child_id 연결, 삭제 정리용 색인)

begin;

alter table public.profiles
  add column if not exists guardian_declared_at timestamptz,   -- 보호자(성인) 본인 선언 시각
  add column if not exists guardian_verified_at timestamptz;   -- 본인인증 연동 시 사용 (지금은 null)

create table if not exists public.child_profiles (
  id           uuid primary key default gen_random_uuid(),
  guardian_id  uuid not null references public.profiles(id) on delete cascade,
  nickname     text not null check (char_length(nickname) between 2 and 12),
  avatar_key   text not null check (avatar_key in ('fox','cat','bear','rabbit','robot','star','dino','panda')),
  age_group    text not null check (age_group in ('7-9','10-13')),
  pin_hash     text,                      -- PBKDF2 (salt:hash). 같은 기기에서 아이 모드 이탈을 막는 편의 장치
  pin_fail_count   int not null default 0,  -- PIN 연속 틀림 (5번이면 10분 잠금, 맞히면 0)
  pin_locked_until timestamptz,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz                -- 소프트 삭제 (30일 뒤 작품과 함께 영구 삭제 — 서버 정리 작업)
);
create index if not exists child_profiles_deleted_idx on public.child_profiles (deleted_at) where deleted_at is not null;
create unique index if not exists child_profiles_guardian_nick_uq
  on public.child_profiles (guardian_id, nickname) where deleted_at is null;
create index if not exists child_profiles_guardian_idx on public.child_profiles (guardian_id);

-- 보호자당 활성 자녀 프로필 최대 5명 (서버 검증의 안전망)
create or replace function public.limit_child_profiles() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.child_profiles
        where guardian_id = new.guardian_id and deleted_at is null) >= 5 then
    raise exception 'child_profile_limit';
  end if;
  return new;
end $$;
drop trigger if exists child_profiles_limit on public.child_profiles;
create trigger child_profiles_limit before insert on public.child_profiles
  for each row execute function public.limit_child_profiles();

-- 법정대리인 동의 증빙
create table if not exists public.guardian_consents (
  id               uuid primary key default gen_random_uuid(),
  guardian_id      uuid not null references public.profiles(id) on delete cascade,
  child_id         uuid references public.child_profiles(id) on delete set null,
  consent_version  text not null,
  items            jsonb not null,
  consented_at     timestamptz not null default now(),
  ip_hash          text,
  revoked_at       timestamptz
);
create index if not exists guardian_consents_guardian_idx on public.guardian_consents (guardian_id);

alter table public.child_profiles   enable row level security;
alter table public.guardian_consents enable row level security;

-- 다른 표들(0009~)과 같은 방식: 앱에서 직접 읽기·쓰기 모두 막고, 서버(/api/children, service_role)만 사용
revoke all on public.child_profiles, public.guardian_consents from anon, authenticated;
revoke all on function public.limit_child_profiles() from public, anon, authenticated;

-- 작업(0005 projects.child_id)을 자녀 프로필에 연결. 영구 삭제 때 작품을 먼저 지우고, 혹시 남으면 보호자 작품으로 남음
do $$ begin
  if to_regclass('public.projects') is not null and not exists (select 1 from pg_constraint where conname = 'projects_child_fk') then
    alter table public.projects add constraint projects_child_fk foreign key (child_id) references public.child_profiles(id) on delete set null;
  end if;
end $$;

commit;
