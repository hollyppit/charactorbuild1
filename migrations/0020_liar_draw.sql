-- 0020_liar_draw.sql  (5단계 네 번째 게임 "숨은 라이어 그림")
-- 선행: 0016(game_rooms, gm_start), 0017(game_words), 0019(gm_housekeeping 갱신본)
-- 방식(방장이 고름): told = 라이어에게 "당신은 라이어"와 분류만 보여 줌 / fool = 라이어도 같은 분류의 다른 제시어를 받아 자기가 라이어인 줄 모름
-- 라운드: word(5초 제시어 확인) → draw(60초 모두 그리기) → vote(30초 라이어 같은 친구 1명, 나는 못 고름)
--   → 가장 많은 표가 라이어 한 명이면 잡힘 → reverse(15초 잡힌 라이어가 진짜 제시어를 4개 보기 중 맞히면 역전)
--   → result(8초). 동점이거나 라이어가 아닌 친구가 가장 많으면 라이어 승리. 라운드 수 1~5(기본 3).
-- 점수: 라이어 승리면 라이어 +3 / 시민 승리면 라이어에게 투표한 친구 +2, 나머지 시민 +1.
-- 그림·투표는 끝나고 1일 뒤 삭제.

begin;

-- 제시어 분류 (같은 분류 안에서 라이어 제시어·역전 보기를 고름)
alter table public.game_words add column if not exists category text;
update public.game_words set category = '동물' where word in ('고양이','강아지','기린','코끼리','펭귄','토끼','거북이','문어','고래','공룡','나비','달팽이','부엉이','사자','원숭이','물고기','개구리','닭','곰','여우');
update public.game_words set category = '음식' where word in ('사과','바나나','수박','딸기','피자','햄버거','아이스크림','케이크','도넛','김밥');
update public.game_words set category = '탈것' where word in ('자동차','자전거','비행기','기차','배','로켓','버스','헬리콥터','잠수함','소방차','해적선');
update public.game_words set category = '자연' where word in ('해','달','별','구름','무지개','눈사람','번개','화산','나무','꽃');
update public.game_words set category = '장소' where word in ('집','성','다리','등대','텐트','미끄럼틀','그네');
update public.game_words set category = '물건' where word in ('우산','시계','안경','모자','신발','연필','가방','책','기타','피아노','축구공','풍선','선물','왕관','칫솔','냉장고','컴퓨터','보물상자');
update public.game_words set category = '상상' where word in ('로봇','외계인','유령','마법사');
update public.game_words set category = '물건' where category is null;

insert into public.games (key, title, status, min_players, max_players, sort)
values ('liar_draw', '숨은 라이어 그림', 'beta', 3, 8, 4) on conflict (key) do nothing;

create table if not exists public.lr_rounds (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  round       int not null check (round between 0 and 4),
  liar_id     uuid references public.profiles(id) on delete set null,
  category    text not null,
  word        text not null,
  liar_word   text,                 -- fool 방식에서만
  options     text[] not null,      -- 역전 보기 4개(정답 포함, 섞음)
  caught      boolean,
  liar_guess  text,
  liar_won    boolean,
  primary key (room_id, round)
);
create table if not exists public.lr_draws (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  round       int not null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  image       text check (image is null or char_length(image) <= 200000),
  created_at  timestamptz not null default now(),
  primary key (room_id, round, user_id)
);
create table if not exists public.lr_votes (
  room_id   uuid not null references public.game_rooms(id) on delete cascade,
  round     int not null,
  voter_id  uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  primary key (room_id, round, voter_id)
);
alter table public.lr_rounds enable row level security;
alter table public.lr_draws  enable row level security;
alter table public.lr_votes  enable row level security;
revoke all on public.lr_rounds, public.lr_draws, public.lr_votes from anon, authenticated;

-- 라운드 준비: 방에 있는 참가자 중 라이어 1명, 제시어(같은 분류 다른 낱말·역전 보기)
create or replace function public.lr_new_round(p_room uuid, p_round int)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[]; v_liar uuid; w record; v_lw text; v_opts text[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  select user_id into v_liar from public.game_room_members where room_id = p_room and left_at is null and user_id = any(v_order) order by random() limit 1;
  -- 같은 분류에 낱말이 5개 이상인 분류에서(제시어·라이어 제시어·역전 보기 4개가 모두 다르게), 이 방에서 아직 안 쓴 낱말
  select gw.word, gw.category into w from public.game_words gw
   where gw.active and gw.category in (select category from public.game_words where active group by category having count(*) >= 5)
     and gw.word not in (select word from public.lr_rounds where room_id = p_room)
   order by random() limit 1;
  if st->>'mode' = 'fool' then
    select word into v_lw from public.game_words where active and category = w.category and word <> w.word order by random() limit 1;
  end if;
  select array_agg(x order by random()) into v_opts from (
    select w.word as x union all
    (select word from public.game_words where active and category = w.category and word <> w.word and word is distinct from v_lw order by random() limit 3)) q;
  insert into public.lr_rounds (room_id, round, liar_id, category, word, liar_word, options) values (p_room, p_round, v_liar, w.category, w.word, v_lw, v_opts)
  on conflict (room_id, round) do update set liar_id = excluded.liar_id, category = excluded.category, word = excluded.word, liar_word = excluded.liar_word,
    options = excluded.options, caught = null, liar_guess = null, liar_won = null;
  delete from public.lr_draws where room_id = p_room and round = p_round;
  delete from public.lr_votes where room_id = p_room and round = p_round;
  update public.game_rooms set state = st || jsonb_build_object('phase', 'word', 'round', p_round, 'deadline', now() + interval '5 seconds'),
         version = version + 1, updated_at = now() where id = p_room;
end $$;

-- 시작 (방장). p_mode = 'told' | 'fool', p_rounds = 1~5
create or replace function public.lr_start(p_actor uuid, p_room uuid, p_mode text, p_rounds int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; res jsonb;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'liar_draw' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by joined_at) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  delete from public.lr_rounds where room_id = p_room;
  update public.game_rooms set state = jsonb_build_object('game', 'liar_draw', 'mode', case when p_mode = 'fool' then 'fool' else 'told' end,
      'phase', 'word', 'round', 0, 'rounds', greatest(1, least(5, coalesce(p_rounds, 3))), 'order', to_jsonb(v_order),
      'draw_sec', 60, 'vote_sec', 30, 'reverse_sec', 15, 'result_sec', 8, 'deadline', now() + interval '5 seconds')
   where id = p_room;
  perform public.lr_new_round(p_room, 0);
  return jsonb_build_object('ok', true);
end $$;

-- 끝: 점수
create or replace function public.lr_finish(p_room uuid)
returns void language plpgsql security definer set search_path = public as $$
declare st jsonb; v_order uuid[];
begin
  select state into st from public.game_rooms where id = p_room;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  with sc as (
    select u.uid, coalesce((
      select sum(case
        when x.liar_won and x.liar_id = u.uid then 3
        when not x.liar_won and x.liar_id is distinct from u.uid then
          case when exists (select 1 from public.lr_votes v where v.room_id = p_room and v.round = x.round and v.voter_id = u.uid and v.target_id = x.liar_id) then 2 else 1 end
        else 0 end)
      from public.lr_rounds x where x.room_id = p_room and x.liar_won is not null), 0) as score
    from unnest(v_order) as u(uid)
  )
  insert into public.game_results (room_id, user_id, rank, score)
  select p_room, sc.uid, dense_rank() over (order by sc.score desc), sc.score from sc
   where exists (select 1 from public.profiles where id = sc.uid)
  on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
  update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal'),
         version = version + 1, updated_at = now() where id = p_room;
  update public.game_room_members set ready = false where room_id = p_room;
end $$;

-- 다음 단계로
create or replace function public.lr_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; ph text; rd int; v_due boolean; lr public.lr_rounds; v_need int; v_done int; v_top uuid; v_topn int; v_ties int;
  next_phase text; secs int;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'liar_draw' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; ph := st->>'phase'; rd := (st->>'round')::int;
  v_due := now() >= (st->>'deadline')::timestamptz;
  select * into lr from public.lr_rounds where room_id = p_room and round = rd;
  select count(*) into v_need from public.game_room_members m where m.room_id = p_room and m.left_at is null
     and m.user_id in (select x::uuid from jsonb_array_elements_text(st->'order') x);
  if ph = 'word' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    next_phase := 'draw'; secs := (st->>'draw_sec')::int;
  elsif ph = 'draw' then
    select count(*) into v_done from public.lr_draws d join public.game_room_members m on m.room_id = d.room_id and m.user_id = d.user_id and m.left_at is null
     where d.room_id = p_room and d.round = rd;
    if v_done < v_need and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    next_phase := 'vote'; secs := (st->>'vote_sec')::int;
  elsif ph = 'vote' then
    select count(*) into v_done from public.lr_votes v join public.game_room_members m on m.room_id = v.room_id and m.user_id = v.voter_id and m.left_at is null
     where v.room_id = p_room and v.round = rd;
    if v_done < v_need and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    -- 가장 많은 표 (한 명만 가장 많아야 함)
    select target_id, n into v_top, v_topn from (select target_id, count(*) n from public.lr_votes where room_id = p_room and round = rd group by target_id) t order by n desc limit 1;
    select count(*) into v_ties from (select target_id, count(*) n from public.lr_votes where room_id = p_room and round = rd group by target_id) t where n = v_topn;
    if v_top is not null and v_ties = 1 and v_top = lr.liar_id then
      update public.lr_rounds set caught = true where room_id = p_room and round = rd;
      -- 잡힌 라이어가 방에 있으면 역전 기회, 없으면 바로 시민 승리
      if exists (select 1 from public.game_room_members where room_id = p_room and user_id = lr.liar_id and left_at is null) then
        next_phase := 'reverse'; secs := (st->>'reverse_sec')::int;
      else
        update public.lr_rounds set liar_won = false where room_id = p_room and round = rd;
        next_phase := 'result'; secs := (st->>'result_sec')::int;
      end if;
    else
      update public.lr_rounds set caught = false, liar_won = true where room_id = p_room and round = rd;
      next_phase := 'result'; secs := (st->>'result_sec')::int;
    end if;
  elsif ph = 'reverse' then
    if lr.liar_guess is null and not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    update public.lr_rounds set liar_won = (liar_guess is not null and liar_guess = word) where room_id = p_room and round = rd;
    next_phase := 'result'; secs := (st->>'result_sec')::int;
  elsif ph = 'result' then
    if not v_due then return jsonb_build_object('ok', true, 'waiting', true); end if;
    if rd + 1 < (st->>'rounds')::int then
      perform public.lr_new_round(p_room, rd + 1);
      return jsonb_build_object('ok', true, 'round', rd + 1);
    end if;
    perform public.lr_finish(p_room);
    return jsonb_build_object('ok', true, 'ended', true);
  else
    return jsonb_build_object('ok', false, 'error', 'not_playing');
  end if;
  update public.game_rooms set state = st || jsonb_build_object('phase', next_phase, 'deadline', now() + make_interval(secs => secs)),
         version = version + 1, updated_at = now() where id = p_room;
  return jsonb_build_object('ok', true, 'phase', next_phase);
end $$;

-- 내기: draw 단계 그림 / vote 단계 투표(나 말고 참가자 1명) / reverse 단계 잡힌 라이어의 제시어 고르기
create or replace function public.lr_submit(p_user uuid, p_room uuid, p_round int, p_image text, p_target uuid, p_choice text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; rd int; lr public.lr_rounds;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'liar_draw' or r.status <> 'playing' then return jsonb_build_object('ok', false, 'error', 'not_playing'); end if;
  st := r.state; rd := (st->>'round')::int;
  if p_round is distinct from rd then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
  if not exists (select 1 from public.game_room_members where room_id = p_room and user_id = p_user and left_at is null)
     or not exists (select 1 from jsonb_array_elements_text(st->'order') x where x::uuid = p_user) then
    return jsonb_build_object('ok', false, 'error', 'not_player');
  end if;
  select * into lr from public.lr_rounds where room_id = p_room and round = rd;
  if st->>'phase' = 'draw' then
    if p_image is null or char_length(p_image) > 200000 or p_image !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
      return jsonb_build_object('ok', false, 'error', 'invalid_image');
    end if;
    insert into public.lr_draws (room_id, round, user_id, image) values (p_room, rd, p_user, p_image)
    on conflict (room_id, round, user_id) do update set image = excluded.image, created_at = now();
  elsif st->>'phase' = 'vote' then
    if p_target is null or p_target = p_user or not exists (select 1 from jsonb_array_elements_text(st->'order') x where x::uuid = p_target) then
      return jsonb_build_object('ok', false, 'error', 'invalid_choice');
    end if;
    insert into public.lr_votes (room_id, round, voter_id, target_id) values (p_room, rd, p_user, p_target)
    on conflict (room_id, round, voter_id) do update set target_id = excluded.target_id;
  elsif st->>'phase' = 'reverse' then
    if p_user is distinct from lr.liar_id then return jsonb_build_object('ok', false, 'error', 'not_player'); end if;
    if lr.liar_guess is not null then return jsonb_build_object('ok', false, 'error', 'step_over'); end if;
    if p_choice is null or not (p_choice = any(lr.options)) then return jsonb_build_object('ok', false, 'error', 'invalid_choice'); end if;
    update public.lr_rounds set liar_guess = p_choice where room_id = p_room and round = rd;
  else
    return jsonb_build_object('ok', false, 'error', 'step_over');
  end if;
  update public.game_rooms set version = version + 1, updated_at = now() where id = p_room;
  perform public.lr_advance(p_room);
  return jsonb_build_object('ok', true);
end $$;

-- 정리: 끝난 지 1일 지난 방의 게임 그림·기록 지우기 (나머지는 0019 와 같음)
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

do $$ declare fn text; begin
  foreach fn in array array['lr_new_round(uuid, int)', 'lr_start(uuid, uuid, text, int)', 'lr_finish(uuid)', 'lr_advance(uuid)',
    'lr_submit(uuid, uuid, int, text, uuid, text)', 'gm_housekeeping()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

commit;
