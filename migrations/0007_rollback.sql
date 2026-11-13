-- 0007 되돌리기: user-assets 버킷의 허용 형식을 0005 상태로 돌린다.
-- 이미 올라간 동영상·ogg·mp4 녹음 파일은 지워지지 않고 그대로 열 수 있다(새로 올리는 것만 막힘).
begin;

update storage.buckets
   set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','audio/mpeg','audio/wav','audio/webm']
 where id = 'user-assets';

commit;
