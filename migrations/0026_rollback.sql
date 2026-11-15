-- 0026 되돌리기: 그림 릴레이·기억 조각 그림 팀전 끄기 (함수는 0021·0017·0024·0018 모양으로)
begin;
update public.games set teams = false where key in ('draw_relay', 'memory_parts');
update public.game_rooms set team_mode = false where game_key in ('draw_relay', 'memory_parts') and status = 'waiting';

create or replace function public.gd_start(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; n int; v_words text[]; i int; opts text[]; res jsonb;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'draw_relay' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  select count(*) into n from public.game_room_members where room_id = p_room and left_at is null;
  if (select count(*) from public.game_words where active and 'draw_relay' = any(games)) < n + 3 then return jsonb_build_object('ok', false, 'error', 'try_again'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by random()) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  n := array_length(v_order, 1);
  select array_agg(word) into v_words from (select word from public.game_words where active and 'draw_relay' = any(games) order by random() limit n) w;
  for i in 1..n loop
    select array_agg(x order by random()) into opts
      from (select v_words[i] as x union all (select word from public.game_words where active and 'draw_relay' = any(games) and word <> v_words[i] order by random() limit 3)) t;
    insert into public.gd_chains (room_id, chain, word, options) values (p_room, i - 1, v_words[i], opts)
    on conflict (room_id, chain) do update set word = excluded.word, options = excluded.options;
  end loop;
  delete from public.gd_entries where room_id = p_room;
  update public.game_rooms set state = jsonb_build_object(
      'phase', 'play', 'step', 0, 'steps', n, 'order', to_jsonb(v_order), 'draw_sec', 60, 'guess_sec', 25,
      'deadline', now() + case when n = 1 then interval '25 seconds' else interval '60 seconds' end),
    version = version + 1, updated_at = now()
   where id = p_room;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.gd_submit(p_user uuid, p_room uuid, p_step int, p_image text, p_choice text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; n int; s int; u int; c int; v_opts text[];
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'draw_relay' or r.status <> 'playing' or r.state->>'phase' <> 'play' then
    return jsonb_build_object('ok', false, 'error', 'not_playing');
  end if;
  st := r.state; n := (st->>'steps')::int; s := (st->>'step')::int;
  if p_step is distinct from s then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select (ord - 1)::int into u from jsonb_array_elements_text(st->'order') with ordinality as t(x, ord) where x::uuid = p_user;
  if u is null then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
  c := ((u - s) % n + n) % n;
  if s < n - 1 then
    if p_image is null or char_length(p_image) > 200000 or p_image !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_image');
    end if;
    insert into public.gd_entries (room_id, chain, step, user_id, kind, image) values (p_room, c, s, p_user, 'draw', p_image)
    on conflict (room_id, chain, step) do update set image = excluded.image, created_at = now();
  else
    select options into v_opts from public.gd_chains where room_id = p_room and chain = c;
    if p_choice is null or not (p_choice = any(v_opts)) then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
    insert into public.gd_entries (room_id, chain, step, user_id, kind, choice) values (p_room, c, s, p_user, 'guess', p_choice)
    on conflict (room_id, chain, step) do update set choice = excluded.choice, created_at = now();
  end if;
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  perform public.gd_advance(p_room);
  return jsonb_build_object('ok', true);
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

create or replace function public.mp_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; ph text; rd int; v_order uuid[]; mr public.mp_rounds; v_need int; v_done int; v_due boolean;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'memory_parts' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; ph := st->>'phase'; rd := (st->>'round')::int;
  v_due := now() >= (st->>'deadline')::timestamptz;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  select * into mr from public.mp_rounds where room_id = p_room and round = rd;
  if ph = 'show' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'draw', 'deadline', now() + make_interval(secs => (st->>'draw_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'draw');
  end if;
  if ph = 'draw' then
    select count(*) into v_need from public.game_room_members where room_id = p_room and left_at is null and user_id = any(v_order) and user_id is distinct from mr.guesser_id;
    select count(*) into v_done from public.mp_parts p join public.game_room_members m on m.room_id = p.room_id and m.user_id = p.user_id and m.left_at is null
     where p.room_id = p_room and p.round = rd;
    if v_done < v_need and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    -- 맞히는 사람이 방을 나갔으면 맞히기를 건너뜀
    if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = mr.guesser_id and left_at is null) then
      update public.mp_rounds set correct = false where room_id = p_room and round = rd;
      update public.game_rooms set state = st || jsonb_build_object('phase', 'result', 'deadline', now() + make_interval(secs => (st->>'result_sec')::int)),
             version = version + 1, updated_at = now() where id = p_room;
      return jsonb_build_object('ok', true, 'phase', 'result');
    end if;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'guess', 'deadline', now() + make_interval(secs => (st->>'guess_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'guess');
  end if;
  if ph = 'guess' then
    if mr.guess_id is null and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.mp_rounds set correct = (guess_id is not null and guess_id = char_id) where room_id = p_room and round = rd;
    update public.game_rooms set state = st || jsonb_build_object('phase', 'result', 'deadline', now() + make_interval(secs => (st->>'result_sec')::int)),
           version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'phase', 'result');
  end if;
  if ph = 'result' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    if rd + 1 < (st->>'rounds')::int then
      perform public.mp_new_round(p_room, rd + 1);
      return jsonb_build_object('ok', true, 'round', rd + 1);
    end if;
    -- 끝: 점수 계산
    with sc as (
      select u.uid,
             coalesce((select sum(2) from public.mp_rounds x where x.room_id = p_room and x.guesser_id = u.uid and x.correct), 0)
           + coalesce((select count(*) from public.mp_parts p join public.mp_rounds x on x.room_id = p.room_id and x.round = p.round
                        where p.room_id = p_room and p.user_id = u.uid and p.image is not null and x.correct), 0) as score
        from unnest(v_order) as u(uid)
    )
    insert into public.game_results (room_id, user_id, rank, score)
    select p_room, sc.uid, dense_rank() over (order by sc.score desc), sc.score from sc
     where exists (select 1 from public.profiles where id = sc.uid)
    on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
    update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal'),
           version = version + 1, updated_at = now() where id = p_room;
    update public.game_room_members set ready = false where room_id = p_room;
    return jsonb_build_object('ok', true, 'ended', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'not_playing');
end $$;

create or replace function public.mp_submit(p_user uuid, p_room uuid, p_round int, p_image text, p_choice text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; rd int; mr public.mp_rounds; v_order uuid[]; v_drawers uuid[]; k int; g int; idx int;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'memory_parts' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; rd := (st->>'round')::int;
  if p_round is distinct from rd then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select * into mr from public.mp_rounds where room_id = p_room and round = rd;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality t(x, o);
  if not (p_user = any(v_order)) then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
  if st->>'phase' = 'draw' then
    if p_user = mr.guesser_id then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
    if p_image is null or char_length(p_image) > 200000 or p_image !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_image');
    end if;
    -- 맡은 칸: 그리는 사람 순서(순서표에서 맞히는 사람 뺀 것)와 라운드로 정함
    select array_agg(x order by o) into v_drawers from unnest(v_order) with ordinality t(x, o) where x is distinct from mr.guesser_id;
    k := array_length(v_drawers, 1);
    select (o - 1)::int into idx from unnest(v_drawers) with ordinality t(x, o) where x = p_user;
    g := (idx + rd) % least(k, 4);
    insert into public.mp_parts (room_id, round, user_id, part, image) values (p_room, rd, p_user, g, p_image)
    on conflict (room_id, round, user_id) do update set image = excluded.image, created_at = now();
  elsif st->>'phase' = 'guess' then
    if p_user is distinct from mr.guesser_id then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
    if mr.guess_id is not null then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
    if p_choice is null or not (p_choice = any(mr.options)) then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
    update public.mp_rounds set guess_id = p_choice where room_id = p_room and round = rd;
  else
    return jsonb_build_object('ok', false, 'error', 'step_over');
  end if;
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  perform public.mp_advance(p_room);
  return jsonb_build_object('ok', true);
end $$;

commit;
