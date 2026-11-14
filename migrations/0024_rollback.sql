-- 0024 되돌리기: mp_new_round·mp_start 를 0018 모양으로 (세트 그림 char_items 는 그대로 남음 — 지우려면 관리자 화면에서)
begin;

create or replace function public.mp_new_round(p_room uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; n int; v_char text; v_opts text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality t(x, o);
  n := array_length(v_order, 1);
  select id into v_char from public.char_items
   where category = 'character' and coalesce(src, '') <> ''
     and id not in (select char_id from public.mp_rounds where room_id = p_room)
   order by random() limit 1;
  if v_char is null then select id into v_char from public.char_items where category = 'character' and coalesce(src, '') <> '' order by random() limit 1; end if;
  select array_agg(x order by random()) into v_opts from (
    select v_char as x union all
    (select id from public.char_items where category = 'character' and coalesce(src, '') <> '' and id <> v_char order by random() limit 3)) t;
  insert into public.mp_rounds (room_id, round, guesser_id, char_id, options)
  values (p_room, p_round, v_order[(p_round % n) + 1], v_char, v_opts)
  on conflict (room_id, round) do update set guesser_id = excluded.guesser_id, char_id = excluded.char_id, options = excluded.options, guess_id = null, correct = null;
  delete from public.mp_parts where room_id = p_room and round = p_round;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'show', 'round', p_round, 'deadline', now() + interval '4 seconds'),
         version = version + 1, updated_at = now() where id = p_room;
end $$;

create or replace function public.mp_start(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; n int; res jsonb;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'memory_parts' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  if (select count(*) from public.char_items where category = 'character' and coalesce(src, '') <> '') < 4 then
    return jsonb_build_object('ok', false, 'error', 'try_again');
  end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by random()) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  n := array_length(v_order, 1);
  delete from public.mp_rounds where room_id = p_room;
  update public.game_rooms set state = jsonb_build_object('game', 'memory_parts', 'phase', 'show', 'round', 0, 'rounds', n,
      'order', to_jsonb(v_order), 'draw_sec', 60, 'guess_sec', 20, 'result_sec', 6, 'deadline', now() + interval '4 seconds')
   where id = p_room;
  perform public.mp_new_round(p_room, 0);
  return jsonb_build_object('ok', true);
end $$;

commit;
