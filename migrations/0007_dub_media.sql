-- 0007_dub_media.sql  (2단계-D: 그림책 더빙 저장 — 장면 동영상, 브라우저별 녹음 형식 허용)
-- 선행: 0005(user-assets 버킷)
-- 바뀌는 것: 비공개 버킷 user-assets 가 받는 파일 형식 목록만 늘린다. 파일당 10MB 제한·공개 여부·정책은 그대로.
--   추가: audio/ogg(파이어폭스 녹음), audio/mp4(사파리·아이폰 녹음), video/mp4, video/webm, video/quicktime(아이폰 동영상)
-- 서버(/api/assets)의 형식 목록과 같아야 한다.

begin;

update storage.buckets
   set allowed_mime_types = array[
     'image/png','image/jpeg','image/webp','image/gif',
     'audio/mpeg','audio/wav','audio/webm','audio/ogg','audio/mp4',
     'video/mp4','video/webm','video/quicktime'
   ]
 where id = 'user-assets';

commit;
