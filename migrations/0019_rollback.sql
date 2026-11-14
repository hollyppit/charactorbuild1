-- 0019 되돌리기 (쓱싹 퀴즈 게임과 그 기록이 삭제됩니다. 게임 결과 기록은 남습니다)
begin;
drop function if exists public.qd_guess(uuid, uuid, int, text);
drop function if exists public.qd_stroke(uuid, uuid, int, jsonb);
drop function if exists public.qd_pick(uuid, uuid, int, text);
drop function if exists public.qd_advance(uuid);
drop function if exists public.qd_start(uuid, uuid, int);
drop function if exists public.qd_finish(uuid);
drop function if exists public.qd_new_turn(uuid, int);
drop function if exists public.qd_close(text, text);
drop function if exists public.qd_norm(text);
drop table if exists public.qd_guess_meta;
drop table if exists public.qd_hits;
drop table if exists public.qd_strokes;
drop table if exists public.qd_turns;
delete from public.game_rooms where game_key = 'sketch_quiz';
delete from public.games where key = 'sketch_quiz';
-- gm_housekeeping 을 0018 모양으로
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int;
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
  delete from public.mp_parts where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics e = row_count;
  delete from public.mp_rounds where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d + e);
end $$;
commit;
