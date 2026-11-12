-- 0005 되돌리기 (계정에 저장된 작업 데이터가 모두 삭제됩니다. 먼저 백업하세요)
-- user-assets 버킷의 파일은 SQL 로 직접 지울 수 없으므로 Supabase 대시보드(Storage)에서 비운 뒤 버킷을 삭제하세요.
begin;
drop function if exists public.save_project(uuid, uuid, int, text, jsonb, uuid);
drop function if exists public.release_quota(uuid, bigint);
drop function if exists public.reserve_quota(uuid, bigint);
drop table if exists public.project_versions;
drop table if exists public.project_assets;
drop table if exists public.user_quota;
drop table if exists public.projects;
commit;
