-- 0006 되돌리기 (이전 기록이 삭제됩니다. 이미 계정으로 옮긴 작업(projects)은 그대로 남습니다)
begin;
drop table if exists public.claim_attempts;
drop table if exists public.legacy_claims;
alter table public.draw_saves drop column if exists claimed_at;
alter table public.draw_saves drop column if exists claimed_by;
commit;
