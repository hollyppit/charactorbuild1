-- 0012 되돌리기 (그룹·그룹원·초대 기록과 그룹 알림이 삭제됩니다)
begin;
drop function if exists public.group_delete(uuid, uuid);
drop function if exists public.group_remove(uuid, uuid, uuid);
drop function if exists public.group_set_role(uuid, uuid, uuid, text);
drop function if exists public.group_respond(uuid, uuid, boolean);
drop function if exists public.group_invite(uuid, uuid, uuid, text);
drop function if exists public.group_create(uuid, text, text);
drop function if exists public.group_seats(uuid);
drop table if exists public.group_invites;
drop table if exists public.group_members;
drop table if exists public.groups;
delete from public.notifications where type in ('group_invite','group_join','group_role','group_removed');
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction'));
commit;
