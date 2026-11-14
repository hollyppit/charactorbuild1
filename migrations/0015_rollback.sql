-- 0015 되돌리기: 예전처럼 회원이 자기 프로필을 직접 고칠 수 있게 (권장하지 않음)
begin;
grant update (nickname, avatar_url, bio, interests, visibility, updated_at) on public.profiles to authenticated;
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
commit;
