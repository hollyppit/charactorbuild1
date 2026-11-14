-- 0017_draw_relay.sql  (5단계 첫 게임 "그림 릴레이" — 그림으로만 전달하기)
-- 선행: 0016(game_rooms, gm_start, gm_bump, gm_housekeeping)
-- 진행: 참가자 N명(2~8)이 각자 한 줄(chain)씩 시작한다. 단계 0: 내 줄의 제시어를 보고 그림 →
--       단계 1..N-2: 옆 사람 줄의 바로 앞 그림만 보고 다시 그림 → 마지막 단계 N-1: 앞 그림을 보고 처음 제시어를 4개 보기 중에서 고르기.
--       사람 u(0부터)가 단계 s 에 맡는 줄 = (u - s) mod N. 모두 내거나 마감 시각이 지나면 다음 단계(서버가 판단).
-- 점수: 줄의 정답을 맞히면 맞힌 사람 +2, 그 줄을 그린 사람마다 +1.
-- 그림은 게임이 끝나고 1일 뒤 지운다(점수·순위만 game_results 에 90일). 글자 입력 칸 없음.

begin;

create table if not exists public.game_words (
  id      serial primary key,
  word    text not null unique check (char_length(word) between 1 and 20),
  active  boolean not null default true
);
insert into public.game_words (word) values
 ('고양이'),('강아지'),('기린'),('코끼리'),('펭귄'),('토끼'),('거북이'),('문어'),('고래'),('공룡'),
 ('나비'),('달팽이'),('부엉이'),('사자'),('원숭이'),('물고기'),('개구리'),('닭'),('곰'),('여우'),
 ('사과'),('바나나'),('수박'),('딸기'),('피자'),('햄버거'),('아이스크림'),('케이크'),('도넛'),('김밥'),
 ('자동차'),('자전거'),('비행기'),('기차'),('배'),('로켓'),('버스'),('헬리콥터'),('잠수함'),('소방차'),
 ('해'),('달'),('별'),('구름'),('무지개'),('눈사람'),('우산'),('번개'),('화산'),('나무'),
 ('꽃'),('집'),('성'),('다리'),('등대'),('텐트'),('시계'),('안경'),('모자'),('신발'),
 ('연필'),('가방'),('책'),('기타'),('피아노'),('축구공'),('풍선'),('선물'),('왕관'),('로봇'),
 ('외계인'),('유령'),('마법사'),('해적선'),('보물상자'),('미끄럼틀'),('그네'),('칫솔'),('냉장고'),('컴퓨터')
on conflict (word) do nothing;

insert into public.games (key, title, status, min_players, max_players, sort)
values ('draw_relay', '그림 릴레이', 'beta', 2, 8, 1) on conflict (key) do nothing;
update public.games set status = 'off' where key = 'ready_check';   -- 틀 시험용은 숨김

create table if not exists public.gd_chains (
  room_id  uuid not null references public.game_rooms(id) on delete cascade,
  chain    int not null check (chain between 0 and 7),
  word     text not null,
  options  text[] not null,          -- 마지막 사람이 고를 4개 보기(정답 포함, 섞음)
  primary key (room_id, chain)
);
create table if not exists public.gd_entries (
  room_id     uuid not null references public.game_rooms(id) on delete cascade,
  chain       int not null check (chain between 0 and 7),
  step        int not null check (step between 0 and 7),
  user_id     uuid references public.profiles(id) on delete set null,
  kind        text not null check (kind in ('draw','guess')),
  image       text check (image is null or char_length(image) <= 200000),   -- 작게 줄인 그림(data URL)
  choice      text check (choice is null or char_length(choice) <= 20),
  created_at  timestamptz not null default now(),
  primary key (room_id, chain, step)
);
alter table public.game_words enable row level security;
alter table public.gd_chains  enable row level security;
alter table public.gd_entries enable row level security;
revoke all on public.game_words, public.gd_chains, public.gd_entries from anon, authenticated;

-- ── 시작 (방장): 순서 섞기·줄마다 제시어와 보기 4개 ──
create or replace function public.gd_start(p_actor uuid, p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; v_order uuid[]; n int; v_words text[]; i int; opts text[]; res jsonb;
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'draw_relay' then return jsonb_build_object('ok', false, 'error', 'room_not_found'); end if;
  select count(*) into n from public.game_room_members where room_id = p_room and left_at is null;
  if (select count(*) from public.game_words where active) < n + 3 then return jsonb_build_object('ok', false, 'error', 'try_again'); end if;
  res := public.gm_start(p_actor, p_room);
  if not (res->>'ok')::boolean then return res; end if;
  select array_agg(user_id order by random()) into v_order from public.game_room_members where room_id = p_room and left_at is null;
  n := array_length(v_order, 1);
  select array_agg(word) into v_words from (select word from public.game_words where active order by random() limit n) w;
  for i in 1..n loop
    select array_agg(x order by random()) into opts
      from (select v_words[i] as x union all (select word from public.game_words where active and word <> v_words[i] order by random() limit 3)) t;
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

-- ── 다음 단계로 (모두 냈거나 마감이 지났을 때만). 마지막 단계 뒤에는 점수 계산·결과 기록·끝 ──
create or replace function public.gd_advance(p_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.game_rooms; st jsonb; n int; s int; v_need int; v_done int; v_order uuid[];
begin
  select * into r from public.game_rooms where id = p_room for update;
  if not found or r.game_key <> 'draw_relay' or r.status <> 'playing' or r.state->>'phase' <> 'play' then
    return jsonb_build_object('ok', false, 'error', 'not_playing');
  end if;
  st := r.state; n := (st->>'steps')::int; s := (st->>'step')::int;
  select array_agg(x::uuid) into v_order from jsonb_array_elements_text(st->'order') x;
  -- 아직 방에 있는 사람 수와 그중 이번 단계를 낸 사람 수
  select count(*) into v_need from public.game_room_members where room_id = p_room and left_at is null and user_id = any(v_order);
  select count(*) into v_done from public.gd_entries e join public.game_room_members m on m.room_id = e.room_id and m.user_id = e.user_id and m.left_at is null
   where e.room_id = p_room and e.step = s;
  if v_done < v_need and now() < (st->>'deadline')::timestamptz then return jsonb_build_object('ok', true, 'waiting', true); end if;
  if s + 1 < n then
    update public.game_rooms set state = st || jsonb_build_object('step', s + 1,
        'deadline', now() + make_interval(secs => case when s + 1 = n - 1 then (st->>'guess_sec')::int else (st->>'draw_sec')::int end)),
      version = version + 1, updated_at = now() where id = p_room;
    return jsonb_build_object('ok', true, 'step', s + 1);
  end if;
  -- 끝: 점수 = 맞힌 줄의 맞힌 사람 +2, 그 줄을 그린 사람 +1
  with corr as (
    select c.chain, exists (select 1 from public.gd_entries g where g.room_id = p_room and g.chain = c.chain and g.kind = 'guess' and g.choice = c.word) as ok
      from public.gd_chains c where c.room_id = p_room
  ), sc as (
    select u.uid, coalesce(sum(case when corr.ok and e.kind = 'guess' then 2 when corr.ok and e.kind = 'draw' and e.image is not null then 1 else 0 end), 0) as score
      from unnest(v_order) as u(uid)
      left join public.gd_entries e on e.room_id = p_room and e.user_id = u.uid
      left join corr on corr.chain = e.chain
     group by u.uid
  )
  insert into public.game_results (room_id, user_id, rank, score)
  select p_room, sc.uid, dense_rank() over (order by sc.score desc), sc.score from sc
   where exists (select 1 from public.profiles where id = sc.uid)
  on conflict (room_id, user_id) do update set rank = excluded.rank, score = excluded.score;
  update public.game_rooms set status = 'ended', ended_at = now(), state = st || jsonb_build_object('phase', 'reveal'),
         version = version + 1, updated_at = now() where id = p_room;
  update public.game_room_members set ready = false where room_id = p_room;
  return jsonb_build_object('ok', true, 'ended', true);
end $$;

-- ── 내기 (그림 또는 보기 고르기). 같은 단계 안에서는 다시 낼 수 있음 ──
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

-- ── 정리에 "끝난 지 1일 지난 방의 그림·제시어 지우기" 추가 (나머지는 0016 과 같음) ──
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

do $$ declare f text; begin
  foreach f in array array['gd_start(uuid, uuid)', 'gd_advance(uuid)', 'gd_submit(uuid, uuid, int, text, text)', 'gm_housekeeping()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

commit;
