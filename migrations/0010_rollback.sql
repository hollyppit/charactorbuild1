-- 0010 되돌리기 (팔로우·좋아요·댓글·차단·알림 기록이 삭제됩니다). 신고 함수는 0009 버전으로 돌아가야 하므로
-- 이 파일 실행 뒤 0009_social_posts.sql 의 social_report 함수 정의 부분을 다시 실행하세요.
-- 댓글 신고 기록(target_type='comment')은 아래에서 함께 지웁니다.
begin;
drop function if exists public.social_delete_comment(uuid, uuid, boolean);
drop function if exists public.social_comment(uuid, uuid, text);
drop function if exists public.social_like(uuid, uuid, boolean);
drop function if exists public.social_block(uuid, uuid);
drop function if exists public.social_follow_respond(uuid, uuid, boolean);
drop function if exists public.social_follow(uuid, uuid);
drop function if exists public.social_notify(uuid, text, uuid, uuid, uuid, jsonb);
drop function if exists public.social_can_view_post(uuid, uuid);
drop function if exists public.social_is_blocked(uuid, uuid);
drop table if exists public.notifications;
drop table if exists public.comments;
drop table if exists public.likes;
drop table if exists public.blocks;
drop table if exists public.follows;
delete from public.reports where target_type = 'comment';
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('post','profile'));
alter table public.social_settings drop column if exists hourly_comment_limit;
alter table public.posts drop constraint if exists posts_comments_mode_check;
alter table public.posts drop column if exists comments_mode, drop column if exists comment_count, drop column if exists like_count;
commit;
