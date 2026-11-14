-- 0024_memory_sets.sql  (기억 조각 그림: 관리자가 만든 "닮은꼴 세트"로 보기 고르기)
-- 선행: 0018(mp_rounds, mp_new_round, mp_start)
-- 세트 그림은 char_items 에 category='memory', id 'mem_<세트>_<번호>', label '세트 이름 — 다른 점', src_back='hidden' 이면 숨김.
-- 라운드마다 이 방에서 아직 안 쓴 세트(보이는 그림 4장 이상)를 하나 골라 그 4장을 보기로 쓰고, 그중 하나가 정답.
-- 세트가 없거나 다 쓰면 예전처럼 기본 캐릭터(category='character') 4개를 쓴다. 표 변경 없음.
begin;

create or replace function public.mp_new_round(p_room uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; n int; v_char text; v_opts text[]; v_set text;
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality t(x, o);
  n := array_length(v_order, 1);
  -- 1) 닮은꼴 세트(4장 이상, 이 방에서 아직 안 쓴 세트)가 있으면 그 세트의 4장을 보기로
  select s into v_set from (
    select substring(id from '^mem_([a-z0-9]+)_') as s from public.char_items
     where category = 'memory' and coalesce(src, '') <> '' and coalesce(src_back, '') <> 'hidden' and id ~ '^mem_[a-z0-9]+_[0-9]+$'
     group by 1 having count(*) >= 4) t
   where s not in (select substring(char_id from '^mem_([a-z0-9]+)_') from public.mp_rounds
                    where room_id = p_room and char_id ~ '^mem_[a-z0-9]+_[0-9]+$')
   order by random() limit 1;
  if v_set is not null then
    select array_agg(id order by random()) into v_opts from (
      select id from public.char_items where category = 'memory' and coalesce(src, '') <> '' and coalesce(src_back, '') <> 'hidden' and id ~ '^mem_[a-z0-9]+_[0-9]+$' and substring(id from '^mem_([a-z0-9]+)_') = v_set order by random() limit 4) t;
    v_char := v_opts[1 + floor(random() * array_length(v_opts, 1))::int];
  else
    -- 2) 세트가 없거나 다 썼으면 예전처럼 기본 캐릭터 4개
    select id into v_char from public.char_items
     where category = 'character' and coalesce(src, '') <> ''
       and id not in (select char_id from public.mp_rounds where room_id = p_room)
     order by random() limit 1;
    if v_char is null then select id into v_char from public.char_items where category = 'character' and coalesce(src, '') <> '' order by random() limit 1; end if;
    select array_agg(x order by random()) into v_opts from (
      select v_char as x union all
      (select id from public.char_items where category = 'character' and coalesce(src, '') <> '' and id <> v_char order by random() limit 3)) t;
  end if;
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
  if (select count(*) from public.char_items where category = 'character' and coalesce(src, '') <> '') < 4
     and not exists (select 1 from public.char_items where category = 'memory' and coalesce(src, '') <> '' and coalesce(src_back, '') <> 'hidden' and id ~ '^mem_[a-z0-9]+_[0-9]+$'
                      group by substring(id from '^mem_([a-z0-9]+)_') having count(*) >= 4) then
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
