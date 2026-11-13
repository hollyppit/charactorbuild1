-- 0011 되돌리기. 먼저 더빙 게시물(kind='dub')과 동영상 장면이 있는지 확인하고, 있으면 관리자 화면에서 지운 뒤 실행하세요
-- (남아 있으면 그림 형식 제한을 되돌릴 때 오류가 납니다). 저장소의 녹음 파일은 SQL 로 지우지 않습니다.
-- 이 파일 실행 뒤 0009_social_posts.sql 의 social_begin_post / social_finish_post / social_delete_post 정의를 다시 실행하세요.
begin;
drop function if exists public.social_post_paths(uuid);
alter table public.post_media drop constraint if exists post_media_mime_check;
alter table public.post_media add constraint post_media_mime_check check (mime in ('image/png','image/jpeg','image/webp'));
alter table public.post_media drop constraint if exists post_media_audio_bytes_check;
alter table public.post_media drop constraint if exists post_media_audio_mime_check;
alter table public.post_media drop column if exists audio_bytes, drop column if exists audio_mime, drop column if exists audio_path;
update storage.buckets set allowed_mime_types = array['image/png','image/jpeg','image/webp'] where id = 'post-media';
commit;
