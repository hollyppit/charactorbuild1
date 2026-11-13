-- 0013 되돌리기 (그룹 그림책·장면·버전·기여 기록·그림 파일 기록이 삭제됩니다)
-- 저장소(user-assets)의 "<사용자>/groups/..." 그림 파일과 그 용량(user_quota)은 SQL 로 정리하지 않습니다.
--   용량을 돌려주려면 먼저: update public.user_quota q set bytes_used = greatest(0, bytes_used -
--     coalesce((select sum(bytes) from public.group_story_assets a where a.uploader_id = q.owner_id), 0));
begin;
drop function if exists public.gs_restore(uuid, uuid, int);
drop function if exists public.gs_review(uuid, uuid, text, boolean, text);
drop function if exists public.gs_submit(uuid, uuid, text);
drop function if exists public.gs_save_draft(uuid, uuid, text, jsonb);
drop function if exists public.gs_unlock(uuid, uuid, text);
drop function if exists public.gs_lock(uuid, uuid, text);
drop function if exists public.gs_assign(uuid, uuid, text, uuid);
drop function if exists public.gs_create(uuid, uuid, text, text, jsonb, jsonb);
drop function if exists public.gs_snapshot(uuid, uuid, text);
drop function if exists public.gs_log(uuid, uuid, text, text, jsonb);
drop function if exists public.gs_role(uuid, uuid);
drop table if exists public.group_story_assets;
drop table if exists public.group_story_activity;
drop table if exists public.group_story_versions;
drop table if exists public.group_story_scenes;
drop table if exists public.group_stories;
delete from public.notifications where type in ('gs_assigned','gs_submitted','gs_approved','gs_returned');
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed'));
commit;
