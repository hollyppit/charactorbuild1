-- 0004 되돌리기 (자녀 프로필·동의 기록이 삭제됩니다. 동의 기록은 법적 보관 의무가 있을 수 있으니 먼저 백업하세요)
begin;
alter table if exists public.projects drop constraint if exists projects_child_fk;
drop trigger if exists child_profiles_limit on public.child_profiles;
drop function if exists public.limit_child_profiles();
drop table if exists public.guardian_consents;
drop table if exists public.child_profiles;
alter table public.profiles drop column if exists guardian_declared_at;
alter table public.profiles drop column if exists guardian_verified_at;
commit;
