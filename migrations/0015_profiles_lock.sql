-- 0015_profiles_lock.sql  (6단계 안정화: 프로필 직접 고치기 막기)
-- 문제: 회원이 공개 키(anon)와 자기 로그인 토큰으로 Supabase 에 직접 요청하면 /api/me 의 검사(닉네임 글자 규칙·나쁜 말·
--       운영자 사칭 금지·사진 주소는 내 avatars 폴더만)를 건너뛰고 닉네임·사진 주소·소개를 바꿀 수 있었다.
--       (예: 사진 주소를 바깥 사이트 그림으로 바꿔 다른 친구 화면에 띄우기)
-- 조치: 프로필 고치기는 서버(/api/me, service_role)만 하도록 anon·authenticated 의 UPDATE 권한과 정책을 없앤다.
--       읽기 정책(profiles_read)은 그대로 둔다. 화면은 이미 /api/me 로만 고치고 있어 영향 없음.

begin;
revoke update on public.profiles from anon, authenticated;
drop policy if exists profiles_update_own on public.profiles;
commit;
