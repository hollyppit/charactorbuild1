-- 0014 되돌리기 (게시 제안·동의 기록과 게시물의 함께 만든 사람 표시가 삭제됩니다. 게시물 자체는 남습니다)
begin;
drop function if exists public.gp_complete(uuid, uuid, uuid);
drop function if exists public.gp_respond(uuid, uuid, boolean);
drop function if exists public.gp_propose(uuid, uuid, text, text, text, text);
drop table if exists public.post_credits;
drop table if exists public.group_publish_consents;
drop table if exists public.group_publish_requests;
alter table public.posts drop column if exists group_story_id;
delete from public.notifications where type in ('gp_consent','gp_declined','gp_ready','gp_published');
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed',
  'gs_assigned','gs_submitted','gs_approved','gs_returned'));
commit;
