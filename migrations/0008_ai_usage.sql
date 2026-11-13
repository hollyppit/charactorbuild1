-- 0008_ai_usage.sql  (2단계-E: AI 사용 기록과 하루 한도)
-- 선행: 0003(profiles)
-- 모든 접근은 서버(Cloudflare Functions, service_role)가 함수로만 수행한다. 클라이언트 직접 접근 없음.
-- 점수: 그림 10점, 목소리 2점, 글 1점 (ai_limits.cost 에서 조정)
-- 한도: 회원 1인 하루 200점 / 비회원 같은 인터넷 주소 하루 600점 / 비회원 전체 하루 2,000점. 관리자는 기록만.
-- 날짜는 한국 시간 기준. 실패한 호출은 점수에서 빠진다. 끝나지 않은 호출(pending)은 쓴 것으로 센다.
-- 기록은 90일 보관(호출 때 조금씩 정리). 그림·글 내용은 저장하지 않는다.
-- 비회원은 인터넷 주소 대신 "날짜마다 바뀌는 해시"(guest_key)만 남겨 날짜를 넘어 추적할 수 없게 한다.

begin;

create table if not exists public.ai_limits (
  id                 int primary key default 1 check (id = 1),
  member_daily       int not null default 200  check (member_daily >= 0),
  guest_ip_daily     int not null default 600  check (guest_ip_daily >= 0),
  guest_total_daily  int not null default 2000 check (guest_total_daily >= 0),
  cost               jsonb not null default '{"image":10,"tts":2,"text":1}'::jsonb,
  updated_at         timestamptz not null default now()
);
insert into public.ai_limits (id) values (1) on conflict (id) do nothing;

create table if not exists public.ai_usage (
  id           bigint generated always as identity primary key,
  day          date not null,
  owner_id     uuid references public.profiles(id) on delete set null,
  guest_key    text,
  is_admin     boolean not null default false,
  endpoint     text not null,
  feature      text not null,
  credits      int not null,
  status       text not null default 'pending' check (status in ('pending', 'ok', 'failed')),
  ms           int,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists ai_usage_owner_day on public.ai_usage (owner_id, day);
create index if not exists ai_usage_guest_day on public.ai_usage (guest_key, day);
create index if not exists ai_usage_day on public.ai_usage (day);
create index if not exists ai_usage_created on public.ai_usage (created_at);

alter table public.ai_limits enable row level security;
alter table public.ai_usage  enable row level security;
revoke all on public.ai_limits, public.ai_usage from anon, authenticated;

-- 한국 날짜
create or replace function public.ai_today() returns date
language sql stable set search_path = public as $$ select (now() at time zone 'Asia/Seoul')::date $$;

-- 점수 예약: 한도 안이면 기록을 만들고 {ok:true,id,used,limit}, 넘으면 {ok:false,reason,used,limit}
create or replace function public.ai_reserve(p_owner uuid, p_guest text, p_admin boolean, p_endpoint text, p_feature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_day date := public.ai_today();
  l public.ai_limits;
  v_cost int;
  v_used int := 0;
  v_total int := 0;
  v_limit int := null;
  v_id bigint;
begin
  select * into l from public.ai_limits where id = 1;
  v_cost := greatest(0, coalesce((l.cost ->> p_feature)::int, 1));

  if not coalesce(p_admin, false) then
    if p_owner is not null then
      perform pg_advisory_xact_lock(hashtext('ai:' || p_owner::text));
      select coalesce(sum(credits), 0) into v_used from public.ai_usage
       where owner_id = p_owner and day = v_day and status <> 'failed';
      v_limit := l.member_daily;
      if v_used + v_cost > v_limit then
        return jsonb_build_object('ok', false, 'reason', 'member_daily', 'used', v_used, 'limit', v_limit);
      end if;
    else
      if p_guest is null or length(p_guest) < 8 then
        return jsonb_build_object('ok', false, 'reason', 'guest_unknown', 'used', 0, 'limit', 0);
      end if;
      perform pg_advisory_xact_lock(hashtext('ai:guest'));      -- 비회원 전체 한도를 정확히 세기 위해 하나의 잠금 사용
      select coalesce(sum(credits) filter (where guest_key = p_guest), 0), coalesce(sum(credits), 0)
        into v_used, v_total
        from public.ai_usage
       where owner_id is null and not is_admin and day = v_day and status <> 'failed';
      v_limit := l.guest_ip_daily;
      if v_total + v_cost > l.guest_total_daily then
        return jsonb_build_object('ok', false, 'reason', 'guest_total', 'used', v_used, 'limit', v_limit);
      end if;
      if v_used + v_cost > v_limit then
        return jsonb_build_object('ok', false, 'reason', 'guest_ip', 'used', v_used, 'limit', v_limit);
      end if;
    end if;
  end if;

  insert into public.ai_usage (day, owner_id, guest_key, is_admin, endpoint, feature, credits)
  values (v_day, p_owner, case when p_owner is null then p_guest end, coalesce(p_admin, false),
          left(coalesce(p_endpoint, ''), 40), left(coalesce(p_feature, ''), 20), v_cost)
  returning id into v_id;

  -- 90일 지난 기록을 조금씩 정리 (예약 실행이 없어서 호출 때 처리)
  if random() < 0.05 then
    delete from public.ai_usage where id in (
      select id from public.ai_usage where created_at < now() - interval '90 days' order by id limit 200);
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'used', v_used + v_cost, 'limit', v_limit, 'cost', v_cost);
end $$;

-- 호출 결과 기록 (실패면 점수에서 빠짐)
create or replace function public.ai_finish(p_id bigint, p_ok boolean, p_ms int)
returns void language sql security definer set search_path = public as $$
  update public.ai_usage
     set status = case when p_ok then 'ok' else 'failed' end,
         ms = greatest(0, least(coalesce(p_ms, 0), 3600000)), finished_at = now()
   where id = p_id and status = 'pending';
$$;

-- 회원 본인의 오늘 사용량
create or replace function public.ai_my_usage(p_owner uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'day', public.ai_today(),
    'used', coalesce((select sum(credits) from public.ai_usage
                       where owner_id = p_owner and day = public.ai_today() and status <> 'failed'), 0),
    'limit', (select member_daily from public.ai_limits where id = 1),
    'cost', (select cost from public.ai_limits where id = 1));
$$;

-- 관리자 요약: 최근 p_days 일 날짜별 합계, 최근 7일 많이 쓴 회원 20명, 현재 한도
create or replace function public.ai_admin_summary(p_days int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'limits', (select to_jsonb(l) - 'id' from public.ai_limits l where id = 1),
    'days', coalesce((
      select jsonb_agg(d order by d.day desc) from (
        select day,
               sum(credits) filter (where status <> 'failed')                                  as credits,
               count(*)                                                                         as calls,
               count(*) filter (where status = 'failed')                                        as failed,
               sum(credits) filter (where status <> 'failed' and owner_id is not null)          as member_credits,
               sum(credits) filter (where status <> 'failed' and owner_id is null and not is_admin) as guest_credits,
               sum(credits) filter (where status <> 'failed' and is_admin)                      as admin_credits,
               count(*) filter (where feature = 'image')                                        as images
          from public.ai_usage
         where day > public.ai_today() - greatest(1, least(coalesce(p_days, 14), 90))
         group by day) d), '[]'::jsonb),
    'top', coalesce((
      select jsonb_agg(t order by t.credits desc) from (
        select u.owner_id, coalesce(p.nickname, '') as nickname,
               sum(u.credits) filter (where u.status <> 'failed') as credits, count(*) as calls
          from public.ai_usage u left join public.profiles p on p.id = u.owner_id
         where u.owner_id is not null and u.day > public.ai_today() - 7
         group by u.owner_id, p.nickname
         order by 3 desc nulls last limit 20) t), '[]'::jsonb));
$$;

-- 관리자 한도 변경
create or replace function public.ai_set_limits(p_member int, p_guest_ip int, p_guest_total int)
returns jsonb language sql security definer set search_path = public as $$
  update public.ai_limits
     set member_daily = greatest(0, least(p_member, 100000)),
         guest_ip_daily = greatest(0, least(p_guest_ip, 100000)),
         guest_total_daily = greatest(0, least(p_guest_total, 1000000)),
         updated_at = now()
   where id = 1
  returning to_jsonb(ai_limits.*) - 'id';
$$;

revoke execute on function public.ai_today() from public, anon, authenticated;
revoke execute on function public.ai_reserve(uuid, text, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.ai_finish(bigint, boolean, int) from public, anon, authenticated;
revoke execute on function public.ai_my_usage(uuid) from public, anon, authenticated;
revoke execute on function public.ai_admin_summary(int) from public, anon, authenticated;
revoke execute on function public.ai_set_limits(int, int, int) from public, anon, authenticated;
grant execute on function public.ai_today() to service_role;
grant execute on function public.ai_reserve(uuid, text, boolean, text, text) to service_role;
grant execute on function public.ai_finish(bigint, boolean, int) to service_role;
grant execute on function public.ai_my_usage(uuid) to service_role;
grant execute on function public.ai_admin_summary(int) to service_role;
grant execute on function public.ai_set_limits(int, int, int) to service_role;

commit;
