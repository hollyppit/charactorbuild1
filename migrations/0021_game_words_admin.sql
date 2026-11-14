-- 0021_game_words_admin.sql  (관리자 모드에서 게임 제시어 관리)
-- 선행: 0017(game_words, gd_start), 0019(qd_new_turn), 0020(category, lr_new_round)
-- 제시어마다 어느 게임에서 쓸지(games: draw_relay·sketch_quiz·liar_draw)를 정한다. 기존 낱말은 세 게임 모두.
-- 게임 함수 3개(gd_start·qd_new_turn·lr_new_round)는 낱말 고르는 조건에 "이 게임에서 쓰는 낱말"만 더해 다시 만든다(나머지 동작은 같음).
-- 관리 화면은 서버(/api/admin/games, 관리자 비밀번호)만 고치고, 표는 바깥에 계속 닫혀 있다.

begin;

alter table public.game_words add column if not exists games text[] not null default array['draw_relay','sketch_quiz','liar_draw'];
alter table public.game_words add column if not exists created_at timestamptz not null default now();
alter table public.game_words drop constraint if exists game_words_category_check;
alter table public.game_words add constraint game_words_category_check check (category is null or char_length(category) between 1 and 12);

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

create or replace function public.qd_new_turn(p_room uuid, p_turn int)
returns boolean language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; n int; t int; v_drawer uuid; v_choices text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid order by o) into v_order from jsonb_array_elements_text(st->'order') with ordinality q(x, o);
  n := array_length(v_order, 1);
  t := p_turn;
  while t < (st->>'turns')::int loop
    v_drawer := v_order[(t % n) + 1];
    exit when exists (select 1 from public.game_room_members where room_id = p_room and user_id = v_drawer and left_at is null);
    t := t + 1;
  end loop;
  if t >= (st->>'turns')::int then return false; end if;
  select array_agg(word) into v_choices from (
    select word from public.game_words where active and 'sketch_quiz' = any(games) and word not in (select coalesce(word, '') from public.qd_turns where room_id = p_room)
     order by random() limit 3) w;
  insert into public.qd_turns (room_id, turn, drawer_id, choices) values (p_room, t, v_drawer, v_choices)
  on conflict (room_id, turn) do update set drawer_id = excluded.drawer_id, choices = excluded.choices, word = null, draw_started = null;
  delete from public.qd_strokes where room_id = p_room and turn = t;
  delete from public.qd_hits where room_id = p_room and turn = t;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'pick', 'turn', t, 'deadline', now() + make_interval(secs => (st->>'pick_sec')::int)),
         version = version + 1, updated_at = now() where id = p_room;
  return true;
end $$;

create or replace function public.lr_new_round(p_room uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; v_liar uuid; w record; v_lw text; v_opts text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  select user_id into v_liar from public.game_room_members where room_id = p_room and left_at is null and user_id = any(v_order) order by random() limit 1;
  -- 같은 분류에 낱말이 5개 이상인 분류에서(제시어·라이어 제시어·역전 보기 4개가 모두 다르게), 이 방에서 아직 안 쓴 낱말
  select gw.word, gw.category into w from public.game_words gw
   where gw.active and 'liar_draw' = any(gw.games) and gw.category in (select category from public.game_words where active and 'liar_draw' = any(games) group by category having count(*) >= 5)
     and gw.word not in (select word from public.lr_rounds where room_id = p_room)
   order by random() limit 1;
  if st->>'mode' = 'fool' then
    select word into v_lw from public.game_words where active and 'liar_draw' = any(games) and category = w.category and word <> w.word order by random() limit 1;
  end if;
  select array_agg(x order by random()) into v_opts from (
    select w.word as x union all
    (select word from public.game_words where active and 'liar_draw' = any(games) and category = w.category and word <> w.word and word is distinct from v_lw order by random() limit 3)) q;
  insert into public.lr_rounds (room_id, round, liar_id, category, word, liar_word, options) values (p_room, p_round, v_liar, w.category, w.word, v_lw, v_opts)
  on conflict (room_id, round) do update set liar_id = excluded.liar_id, category = excluded.category, word = excluded.word, liar_word = excluded.liar_word,
    options = excluded.options, caught = null, liar_guess = null, liar_won = null;
  delete from public.lr_draws where room_id = p_room and round = p_round;
  delete from public.lr_votes where room_id = p_room and round = p_round;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'word', 'round', p_round, 'deadline', now() + interval '5 seconds'),
         version = version + 1, updated_at = now() where id = p_room;
end $$;

do $$ declare f text; begin
  foreach f in array array['gd_start(uuid, uuid)', 'qd_new_turn(uuid, int)', 'lr_new_round(uuid, int)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
