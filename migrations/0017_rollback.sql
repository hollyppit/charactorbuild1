-- 0017 되돌리기 (그림 릴레이 게임·낱말 목록·릴레이 그림이 삭제됩니다. 게임 방·결과 기록은 남습니다)
begin;
drop function if exists public.gd_submit(uuid, uuid, int, text, text);
drop function if exists public.gd_advance(uuid);
drop function if exists public.gd_start(uuid, uuid);
drop table if exists public.gd_entries;
drop table if exists public.gd_chains;
drop table if exists public.game_words;
delete from public.game_rooms where game_key = 'draw_relay';
delete from public.games where key = 'draw_relay';
update public.games set status = 'beta' where key = 'ready_check';
-- gm_housekeeping 을 0016 모양으로
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int;
begin
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'waiting' and expires_at < now();
  get diagnostics a = row_count;
  update public.game_rooms set status = 'closed', ended_at = now(), version = version + 1, updated_at = now()
   where status = 'playing' and started_at < now() - interval '6 hours';
  get diagnostics b = row_count;
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c);
end $$;
commit;
