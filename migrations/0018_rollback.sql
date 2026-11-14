-- 0018 되돌리기 (기억 조각 그림 게임과 그 그림이 삭제됩니다. 게임 결과 기록은 남습니다)
begin;
drop function if exists public.mp_submit(uuid, uuid, int, text, text);
drop function if exists public.mp_advance(uuid);
drop function if exists public.mp_start(uuid, uuid);
drop function if exists public.mp_new_round(uuid, int);
drop table if exists public.mp_parts;
drop table if exists public.mp_rounds;
delete from public.game_rooms where game_key = 'memory_parts';
delete from public.games where key = 'memory_parts';
-- gm_housekeeping 을 0017 모양으로
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int;
begin
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'waiting' and expires_at < now();
  get diagnostics a = row_count;
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'playing' and started_at < now() - interval '6 hours';
  get diagnostics b = row_count;
  delete from public.gd_entries where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics d = row_count;
  delete from public.gd_chains where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d);
end $$;
commit;
