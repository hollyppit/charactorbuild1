-- 0011_dub_posts.sql  (더빙 게시: 장면별 목소리 녹음 + 장면 동영상)
-- 선행: 0009(posts, post_media, social_* 함수), 0010
-- 바뀌는 것
--  - post_media: 장면 녹음 칸(audio_path/audio_mime/audio_bytes) 추가, 그림 형식에 동영상(mp4·webm·mov) 허용
--  - post-media 버킷: 녹음·동영상 형식 허용 (파일당 10MB 그대로, 비공개 그대로)
--  - social_begin_post / social_finish_post / social_delete_post: 녹음 파일도 용량에 세고, 지울 때 함께 지움

begin;

alter table public.post_media
  add column if not exists audio_path  text unique,
  add column if not exists audio_mime  text,
  add column if not exists audio_bytes int;
alter table public.post_media drop constraint if exists post_media_audio_mime_check;
alter table public.post_media add constraint post_media_audio_mime_check
  check (audio_mime is null or audio_mime in ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'));
alter table public.post_media drop constraint if exists post_media_audio_bytes_check;
alter table public.post_media add constraint post_media_audio_bytes_check
  check (audio_bytes is null or audio_bytes between 1 and 10485760);
alter table public.post_media drop constraint if exists post_media_mime_check;
alter table public.post_media add constraint post_media_mime_check
  check (mime in ('image/png','image/jpeg','image/webp','video/mp4','video/webm','video/quicktime'));

update storage.buckets
   set allowed_mime_types = array['image/png','image/jpeg','image/webp',
                                  'video/mp4','video/webm','video/quicktime',
                                  'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav']
 where id = 'post-media';

-- 게시물 한 개의 모든 파일 경로 (그림 + 녹음)
create or replace function public.social_post_paths(p_post uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x), '{}') from (
    select path as x from public.post_media where post_id = p_post
    union all
    select audio_path from public.post_media where post_id = p_post and audio_path is not null) t;
$$;

create or replace function public.social_begin_post(p_owner uuid, p_id uuid, p_kind text, p_title text, p_caption text,
                                                    p_visibility text, p_project uuid, p_replaces uuid, p_media jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.social_settings;
  v_sanction jsonb;
  v_today_cnt int;
  v_bytes bigint;
  v_n int;
  v_stale text[] := '{}';
  v_stale_bytes bigint := 0;
  r record;
begin
  perform pg_advisory_xact_lock(hashtext('post:' || p_owner::text));
  select * into st from public.social_settings where id = 1;

  v_sanction := public.social_active_sanction(p_owner);
  if v_sanction is not null then
    return jsonb_build_object('ok', false, 'error', 'sanctioned', 'sanction', v_sanction);
  end if;

  for r in select id, bytes from public.posts where owner_id = p_owner and status = 'uploading' and created_at < now() - interval '1 hour' loop
    v_stale := v_stale || public.social_post_paths(r.id);
    v_stale_bytes := v_stale_bytes + r.bytes;
    delete from public.posts where id = r.id;
  end loop;
  if v_stale_bytes > 0 then perform public.release_quota(p_owner, v_stale_bytes); end if;

  select count(*) into v_today_cnt from public.posts
   where owner_id = p_owner and created_at >= ((now() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul');
  if v_today_cnt >= st.daily_post_limit then
    return jsonb_build_object('ok', false, 'error', 'daily_post_limit', 'limit', st.daily_post_limit, 'stale_paths', to_jsonb(v_stale));
  end if;

  v_n := jsonb_array_length(coalesce(p_media, '[]'::jsonb));
  if v_n < 1 or v_n > 20 then return jsonb_build_object('ok', false, 'error', 'invalid_media', 'stale_paths', to_jsonb(v_stale)); end if;
  select coalesce(sum((m->>'bytes')::bigint + coalesce((m->>'audio_bytes')::bigint, 0)), 0) into v_bytes from jsonb_array_elements(p_media) m;

  if p_project is not null and not exists (select 1 from public.projects where id = p_project and owner_id = p_owner) then
    p_project := null;
  end if;
  if p_replaces is not null and not exists (select 1 from public.posts where id = p_replaces and owner_id = p_owner and status <> 'deleted') then
    p_replaces := null;
  end if;

  if not public.reserve_quota(p_owner, v_bytes) then
    return jsonb_build_object('ok', false, 'error', 'quota_exceeded', 'stale_paths', to_jsonb(v_stale));
  end if;

  insert into public.posts (id, owner_id, kind, title, caption, visibility, source_project_id, replaces_post_id, media_count, bytes)
  values (p_id, p_owner, p_kind, p_title, nullif(p_caption, ''), p_visibility, p_project, p_replaces, v_n, v_bytes);

  insert into public.post_media (post_id, owner_id, idx, path, mime, bytes, width, height, sha256, body, audio_path, audio_mime, audio_bytes)
  select p_id, p_owner, (m->>'idx')::int, m->>'path', m->>'mime', (m->>'bytes')::int,
         nullif(m->>'width', '')::int, nullif(m->>'height', '')::int, m->>'sha256', nullif(m->>'body', ''),
         nullif(m->>'audio_path', ''), nullif(m->>'audio_mime', ''), nullif(m->>'audio_bytes', '')::int
    from jsonb_array_elements(p_media) m;

  return jsonb_build_object('ok', true, 'id', p_id, 'stale_paths', to_jsonb(v_stale));
end $$;

create or replace function public.social_finish_post(p_owner uuid, p_post uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  st public.social_settings;
  p public.posts;
  v_status text;
  v_old_paths text[] := '{}';
  v_old_bytes bigint := 0;
begin
  select * into st from public.social_settings where id = 1;
  select * into p from public.posts where id = p_post and owner_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p.status <> 'uploading' then return jsonb_build_object('ok', true, 'status', p.status, 'old_paths', '[]'::jsonb); end if;

  update public.post_media set status = 'ready' where post_id = p_post;
  v_status := case when st.require_approval then 'pending' else 'published' end;
  update public.posts set status = v_status, updated_at = now(),
         published_at = case when v_status = 'published' then now() else null end
   where id = p_post;

  if p.replaces_post_id is not null then
    v_old_paths := public.social_post_paths(p.replaces_post_id);
    select bytes into v_old_bytes from public.posts where id = p.replaces_post_id and owner_id = p_owner and status <> 'deleted';
    update public.posts set status = 'deleted', updated_at = now() where id = p.replaces_post_id and owner_id = p_owner;
    delete from public.post_media where post_id = p.replaces_post_id;
    if coalesce(v_old_bytes, 0) > 0 then
      perform public.release_quota(p_owner, v_old_bytes);
      update public.posts set bytes = 0 where id = p.replaces_post_id;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'status', v_status, 'old_paths', to_jsonb(v_old_paths));
end $$;

create or replace function public.social_delete_post(p_post uuid, p_owner uuid, p_admin boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.posts;
  v_paths text[];
begin
  select * into p from public.posts where id = p_post for update;
  if not found or p.status = 'deleted' or (not coalesce(p_admin, false) and p.owner_id is distinct from p_owner) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  v_paths := public.social_post_paths(p_post);
  delete from public.post_media where post_id = p_post;
  update public.posts set status = 'deleted', bytes = 0, updated_at = now() where id = p_post;
  if p.bytes > 0 then perform public.release_quota(p.owner_id, p.bytes); end if;
  return jsonb_build_object('ok', true, 'paths', to_jsonb(v_paths));
end $$;

revoke execute on function public.social_post_paths(uuid) from public, anon, authenticated;
grant execute on function public.social_post_paths(uuid) to service_role;
-- begin/finish/delete 는 create or replace 라 0009 의 권한(서버 전용)이 그대로 유지된다. 확실히 하려고 다시 지정
revoke execute on function public.social_begin_post(uuid, uuid, text, text, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.social_finish_post(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.social_delete_post(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.social_begin_post(uuid, uuid, text, text, text, text, uuid, uuid, jsonb) to service_role;
grant execute on function public.social_finish_post(uuid, uuid) to service_role;
grant execute on function public.social_delete_post(uuid, uuid, boolean) to service_role;

commit;
