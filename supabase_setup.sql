-- 1. 아이템 테이블 (카테고리별 아이템 목록)
create table if not exists char_items (
  id text primary key,
  category text not null,
  label text not null,
  emoji text default '🖼️',
  src text default '',
  src_back text default '',
  bg_emoji text default '',
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- 2. 위치/크기 테이블
create table if not exists char_positions (
  id text primary key,
  scale integer default 100,
  offset_x integer default 0,
  offset_y integer default 0,
  rotate integer default 0,
  updated_at timestamptz default now()
);

-- ※ 기존 테이블에 rotate 컬럼이 없는 경우 아래 SQL을 Supabase Dashboard > SQL Editor에서 실행하세요:
-- ALTER TABLE char_positions ADD COLUMN IF NOT EXISTS rotate integer default 0;

-- 3. RLS 비활성화 (관리자 앱이므로 public 접근 허용)
alter table char_items enable row level security;
alter table char_positions enable row level security;

create policy "public read items" on char_items for select using (true);
create policy "public write items" on char_items for all using (true);
create policy "public read positions" on char_positions for select using (true);
create policy "public write positions" on char_positions for all using (true);

-- Storage 버킷 생성 (Supabase Dashboard에서 수동으로 해야 함)
-- Dashboard → Storage → New Bucket → 이름: char-assets → Public 체크

-- ─────────────────────────────────────────────────────────
-- 3. 직접 그리기 중간 저장 테이블
-- ─────────────────────────────────────────────────────────
create table if not exists draw_saves (
  id uuid primary key default gen_random_uuid(),
  user_name text not null,
  password_hash text not null,      -- SHA-256 hex (클라이언트/서버에서 해시 후 저장)
  thumbnail_url text,               -- Supabase Storage 공개 URL (thumb.jpg)
  layer_count int default 0,
  layers_meta jsonb,                -- [{name, kind, opacity, visible, locked, scale, rotate, offsetX, offsetY, url}]
  canvas_w int,
  canvas_h int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table draw_saves enable row level security;
create policy "public read draw_saves"   on draw_saves for select using (true);
create policy "public insert draw_saves" on draw_saves for insert with check (true);
create policy "public delete draw_saves" on draw_saves for delete using (true);
create policy "public update draw_saves" on draw_saves for update using (true);

-- Storage 버킷: draw-saves (Public)
-- Dashboard → Storage → New Bucket → 이름: draw-saves → Public 체크
