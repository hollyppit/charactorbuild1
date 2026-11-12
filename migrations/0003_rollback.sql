-- 0003 되돌리기 (프로필 데이터가 삭제됩니다)
begin;
drop policy if exists "avatars own insert" on storage.objects;
drop policy if exists "avatars own update" on storage.objects;
drop policy if exists "avatars own delete" on storage.objects;
-- avatars 버킷은 Supabase 대시보드(Storage)에서 파일을 비운 뒤 직접 삭제하세요 (SQL 로 storage 테이블을 직접 지울 수 없음)
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.profiles;
commit;
