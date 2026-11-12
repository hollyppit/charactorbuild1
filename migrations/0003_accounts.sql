-- 0003_accounts.sql  (1단계-A: 회원 프로필)
-- 적용 전 선행: Supabase Authentication 에서 Google/Kakao 설정, 이메일 로그인 비활성화.
-- 적용 순서: 코드 배포 후 이 SQL 적용 (코드는 profiles 가 없으면 /api/me 가 503 을 돌려주고 기존 기능에는 영향 없음)

begin;

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text not null unique check (char_length(nickname) between 2 and 20),
  avatar_url  text,
  bio         text check (bio is null or char_length(bio) <= 300),
  interests   text[] not null default '{}',
  visibility  text not null default 'private' check (visibility in ('public','followers','private')),
  role        text not null default 'user' check (role in ('user','admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- 본인 + 공개 프로필만 조회
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or visibility = 'public');
-- 본인 행만 수정 (수정 가능한 컬럼은 아래 GRANT 로 제한 → role 은 변경 불가)
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update (nickname, avatar_url, bio, interests, visibility, updated_at) on public.profiles to authenticated;

-- 가입 시 프로필 자동 생성 (닉네임 중복이면 숫자를 붙임)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text; nick text; n int := 0;
begin
  base := coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''),
                   nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
                   nullif(trim(new.raw_user_meta_data->>'nickname'), ''), 'user');
  base := left(regexp_replace(base, '[^0-9A-Za-z가-힣_]', '', 'g'), 14);
  if char_length(base) < 2 then base := 'user'; end if;
  nick := base;
  while exists (select 1 from public.profiles where nickname = nick) loop
    n := n + 1;
    nick := base || n::text;
  end loop;
  insert into public.profiles (id, nickname, avatar_url)
  values (new.id, nick,
          coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'));
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 프로필 이미지 버킷 (공개 읽기, 본인 폴더 {user_id}/ 에만 쓰기)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

create policy "avatars own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars own update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatars own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

commit;
