-- 0009 되돌리기 (게시물·신고·제재 기록이 삭제됩니다)
-- 버킷 post-media 의 파일은 SQL 로 지우지 않습니다. 대시보드에서 버킷을 비운 뒤 삭제하세요.
-- 게시물 그림이 쓰던 저장 용량(user_quota)은 되돌리지 않으므로, 필요하면 아래 주석의 문장을 먼저 실행하세요.
--   update public.user_quota q set bytes_used = greatest(0, bytes_used - coalesce(
--     (select sum(bytes) from public.posts p where p.owner_id = q.owner_id and p.status <> 'deleted'), 0));
begin;
drop function if exists public.social_report(uuid, text, uuid, text, text);
drop function if exists public.social_delete_post(uuid, uuid, boolean);
drop function if exists public.social_finish_post(uuid, uuid);
drop function if exists public.social_begin_post(uuid, uuid, text, text, text, text, uuid, uuid, jsonb);
drop function if exists public.social_active_sanction(uuid);
drop table if exists public.sanctions;
drop table if exists public.reports;
drop table if exists public.post_media;
drop table if exists public.posts;
drop table if exists public.social_settings;
commit;
