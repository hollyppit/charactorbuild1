-- 0016 되돌리기 (게임 방·참가·결과 기록과 게임 초대 알림이 삭제됩니다)
begin;
drop function if exists public.gm_housekeeping();
drop function if exists public.gm_end(uuid, uuid, jsonb);
drop function if exists public.gm_set_state(uuid, uuid, jsonb, int);
drop function if exists public.gm_start(uuid, uuid);
drop function if exists public.gm_ready(uuid, uuid, boolean);
drop function if exists public.gm_kick(uuid, uuid, uuid);
drop function if exists public.gm_leave(uuid, uuid);
drop function if exists public.gm_invite(uuid, uuid, uuid);
drop function if exists public.gm_join(uuid, text);
drop function if exists public.gm_create(uuid, text, int);
drop function if exists public.gm_expire(uuid);
drop function if exists public.gm_active_rooms(uuid);
drop function if exists public.gm_bump(uuid);
drop table if exists public.game_results;
drop table if exists public.game_room_members;
drop table if exists public.game_rooms;
drop table if exists public.games;
delete from public.notifications where type = 'game_invite';
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'follow','follow_request','follow_accept','like','comment','post_approved','post_rejected','post_hidden','post_removed',
  'comment_hidden','sanction','group_invite','group_join','group_role','group_removed',
  'gs_assigned','gs_submitted','gs_approved','gs_returned',
  'gp_consent','gp_declined','gp_ready','gp_published'));
commit;
