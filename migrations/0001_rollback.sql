-- 0001_rollback.sql : 0001_security.sql 되돌리기 (정책 복원 + RLS 해제 + 버킷 제한 해제)
begin;

alter table public.dub_projects disable row level security;
alter table public.dub_scenes   disable row level security;

create policy "public read items"        on public.char_items     for select using (true);
create policy "public write items"       on public.char_items     for all    using (true);
create policy "public read positions"    on public.char_positions for select using (true);
create policy "public write positions"   on public.char_positions for all    using (true);
create policy "public read draw_saves"   on public.draw_saves     for select using (true);
create policy "public insert draw_saves" on public.draw_saves     for insert with check (true);
create policy "public update draw_saves" on public.draw_saves     for update using (true);
create policy "public delete draw_saves" on public.draw_saves     for delete using (true);

create policy "public upload char-assets" on storage.objects for insert with check (bucket_id = 'char-assets');
create policy "public update char-assets" on storage.objects for update with check (bucket_id = 'char-assets');
create policy "public delete char-assets" on storage.objects for delete using (bucket_id = 'char-assets');
create policy "draw-saves anon insert"    on storage.objects for insert with check (bucket_id = 'draw-saves');
create policy "draw-saves anon delete"    on storage.objects for delete using (bucket_id = 'draw-saves');
create policy "public upload dub-media"   on storage.objects for insert with check (bucket_id = 'dub-media');
create policy "public update dub-media"   on storage.objects for update using (bucket_id = 'dub-media');
create policy "public delete dub-media"   on storage.objects for delete using (bucket_id = 'dub-media');

update storage.buckets set file_size_limit = null, allowed_mime_types = null
where id in ('char-assets','draw-saves');

commit;
