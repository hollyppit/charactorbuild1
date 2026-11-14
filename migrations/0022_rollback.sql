-- 0022 되돌리기 (퀴즈 배틀 게임과 그 기록이 삭제됩니다. 게임 결과 기록과 퀴즈 문제(아이템)는 남습니다)
begin;
drop function if exists public.qb_answer(uuid, uuid, int, int);
drop function if exists public.qb_advance(uuid);
drop function if exists public.qb_start(uuid, uuid, int);
drop function if exists public.qb_opts(text);
drop table if exists public.qb_answers;
drop table if exists public.qb_questions;
delete from public.game_rooms where game_key = 'quiz_battle';
delete from public.games where key = 'quiz_battle';
-- gm_housekeeping 을 0020 모양으로
create or replace function public.gm_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int; c int; d int; e int; f int; g int;
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
  delete from public.qd_strokes where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics f = row_count;
  delete from public.qd_hits where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qd_turns where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.qd_guess_meta where room_id in (
    select id from public.game_rooms where status in ('ended','closed'));
  delete from public.lr_draws where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  get diagnostics g = row_count;
  delete from public.lr_votes where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.lr_rounds where room_id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '1 day');
  delete from public.game_rooms where id in (
    select id from public.game_rooms where status in ('ended','closed') and ended_at < now() - interval '90 days' limit 500);
  get diagnostics c = row_count;
  return jsonb_build_object('expired', a, 'stale', b, 'deleted', c, 'drawings', d + e + f + g);
end $$;
commit;
