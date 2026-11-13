-- 0008 되돌리기 (AI 사용 기록과 한도 설정이 삭제됩니다)
-- 먼저 서버 코드를 이전 버전으로 되돌리거나, 그대로 두면 서버는 "기록 기능 없음"으로 보고 한도 없이 AI 를 허용합니다.
begin;
drop function if exists public.ai_set_limits(int, int, int);
drop function if exists public.ai_admin_summary(int);
drop function if exists public.ai_my_usage(uuid);
drop function if exists public.ai_finish(bigint, boolean, int);
drop function if exists public.ai_reserve(uuid, text, boolean, text, text);
drop function if exists public.ai_today();
drop table if exists public.ai_usage;
drop table if exists public.ai_limits;
commit;
