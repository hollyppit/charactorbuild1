-- 0004_child_profiles.sql  (1단계-A2: 보호자 계정 아래 아동 프로필)
-- 선행: 0003_accounts.sql (profiles 테이블) 적용 완료
-- 아동은 Supabase Auth 계정을 갖지 않는다. 보호자(profiles) 아래의 "프로필" 행으로만 존재한다.
-- 쓰기는 모두 /api/children (서버, service_role) 에서 검증 후 수행한다.

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
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz                -- 소프트 삭제 (30일 뒤 영구 삭제 대상)
);
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

create policy child_profiles_read_own on public.child_profiles for select
  using (guardian_id = auth.uid());
create policy guardian_consents_read_own on public.guardian_consents for select
  using (guardian_id = auth.uid());

-- 직접 쓰기 차단, pin_hash 는 읽을 수 없음
revoke all on public.child_profiles, public.guardian_consents from anon, authenticated;
grant select (id, guardian_id, nickname, avatar_key, age_group, created_at, deleted_at)
  on public.child_profiles to authenticated;
grant select on public.guardian_consents to authenticated;

commit;
