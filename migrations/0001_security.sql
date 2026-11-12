-- 0001_security.sql  (0단계 보안 긴급 조치)
-- ⚠ 적용 순서: 반드시 (1) Cloudflare 환경변수 SUPABASE_SERVICE_KEY, ADMIN_PW_HASH 등록
--              (2) 이 저장소의 functions/ 변경분 배포 및 동작 확인  (3) 그 다음에 이 SQL 적용.
--   Functions 가 service_role 키로 접근하기 전에 적용하면 사이트의 목록/저장/관리자 기능이 즉시 멈춘다.
-- 적용 전 백업: draw_saves 전체 + 아래 정책 목록(0001_rollback.sql 로 복원 가능).

begin;

-- 1) RLS 꺼진 테이블 잠금 (Functions 는 service_role 로 접근하므로 영향 없음)
alter table public.dub_projects enable row level security;
alter table public.dub_scenes   enable row level security;

-- 2) 이 저장소가 쓰는 테이블의 anon 직접 접근 제거
--    (클라이언트는 Supabase REST 를 직접 호출하지 않고 /api/* 만 사용함을 확인)
drop policy if exists "public read items"        on public.char_items;
drop policy if exists "public write items"       on public.char_items;
drop policy if exists "public read positions"    on public.char_positions;
drop policy if exists "public write positions"   on public.char_positions;
drop policy if exists "public read draw_saves"   on public.draw_saves;
drop policy if exists "public insert draw_saves" on public.draw_saves;
drop policy if exists "public update draw_saves" on public.draw_saves;
drop policy if exists "public delete draw_saves" on public.draw_saves;

-- 3) 이 저장소가 쓰는 버킷의 anon 쓰기·삭제 정책 제거 (파일 읽기는 공개 URL 로 계속 가능)
--    ※ draw-saves 의 SELECT 정책(객체 목록 조회 허용)은 이번 단계에서 유지 — 별도 점검 후 정리
--    ※ bold-media 버킷 정책은 다른 서비스 사용 가능성이 있어 건드리지 않음
drop policy if exists "public upload char-assets" on storage.objects;
drop policy if exists "public update char-assets" on storage.objects;
drop policy if exists "public delete char-assets" on storage.objects;
drop policy if exists "draw-saves anon insert"    on storage.objects;
drop policy if exists "draw-saves anon delete"    on storage.objects;
drop policy if exists "public upload dub-media"   on storage.objects;
drop policy if exists "public update dub-media"   on storage.objects;
drop policy if exists "public delete dub-media"   on storage.objects;

-- 4) 버킷 용량·형식 제한
update storage.buckets set file_size_limit = 5242880,
  allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif']
where id = 'char-assets';
update storage.buckets set file_size_limit = 20971520,
  allowed_mime_types = array['image/png','image/jpeg']
where id = 'draw-saves';

commit;
