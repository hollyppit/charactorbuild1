// 작품 게시물
//  GET    /api/posts?feed=latest[&before=ISO]   둘러보기: 전체 공개 게시물 최신순 24개 (차단 관계 제외)
//  GET    /api/posts?feed=following[&before=]   팔로잉: 내가 팔로우한 사람의 게시물(팔로워만 포함)
//  GET    /api/posts?id=                        게시물 하나(그림 전체·좋아요·댓글 가능 여부)
//  GET    /api/posts?mine=1[&project=uuid]      내 게시물 목록(상태 포함)
//  POST   /api/posts                            게시 시작 → 그림 업로드 토큰 발급
//  POST   /api/posts?action=finish              {id} 업로드 확인 후 확인 대기 또는 공개
//  PATCH  /api/posts?id=                        {title?, caption?} 내 게시물 고치기 (승인 모드면 다시 확인 대기)
//  DELETE /api/posts?id=                        내 게시물 삭제
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { signUpload, objectInfo, removeObjects, POST_BUCKET } from './_lib/storage.js';
import { whoIs, disabledReply, rpc, attachCovers, mediaOf, publicPost, statusText, POST_COLS, UUID, KINDS, MIME_EXT,
  blockedIds, followeeIds, followStatus, notInList } from './_lib/social.js';

const VIS = ['public', 'followers'];
const CMODES = ['all', 'followers', 'off'];

const PAGE = 24;
const SHA = /^[0-9a-f]{64}$/;
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);

const ERR = {
  sanctioned: '지금은 게시할 수 없어요 (이용 제한 중). 자세한 내용은 마이페이지에서 확인해 주세요.',
  daily_post_limit: '오늘은 더 게시할 수 없어요. 내일 다시 해 주세요.',
  quota_exceeded: '저장 공간이 부족해요. 마이페이지에서 정리해 주세요.',
  invalid_media: '그림이 없거나 너무 많아요 (1~20장).',
};

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,PATCH,DELETE,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 64 * 1024, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);

  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  const sb = makeSb(env);
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  // ── 읽기 ──
  if (request.method === 'GET') {
    const feed = url.searchParams.get('feed');
    if (feed === 'latest' || feed === 'following') {
      const before = url.searchParams.get('before');
      const me = who.user ? who.user.id : null;
      const blocked = await blockedIds(env, me);
      let q;
      if (feed === 'following') {
        if (!me) return json({ error: '로그인하면 팔로잉 피드를 볼 수 있어요.', code: 'login_required' }, 401);
        const ids = (await followeeIds(env, me)).filter(x => !blocked.includes(x));
        if (!ids.length) return json({ posts: [], next: null });
        q = `/rest/v1/posts?status=eq.published&visibility=in.(public,followers)&owner_id=in.(${ids.join(',')})&select=${POST_COLS}&order=published_at.desc&limit=${PAGE}`;
      } else {
        q = `/rest/v1/posts?status=eq.published&visibility=eq.public${notInList('owner_id', blocked)}&select=${POST_COLS}&order=published_at.desc&limit=${PAGE}`;
      }
      if (before && !isNaN(Date.parse(before))) q += `&published_at=lt.${encodeURIComponent(new Date(before).toISOString())}`;
      const r = await sb(q);
      if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
      const rows = r.ok ? await r.json() : [];
      const posts = (await attachCovers(env, rows)).map(p => ({ ...publicPost(p), cover: p.cover }));
      return json({ posts, next: rows.length === PAGE ? rows[rows.length - 1].published_at : null });
    }

    if (url.searchParams.get('mine') === '1') {
      if (!who.user) return json({ error: 'login_required' }, 401);
      let q = `/rest/v1/posts?owner_id=eq.${who.user.id}&status=neq.deleted&select=${POST_COLS}&order=created_at.desc&limit=100`;
      const pj = url.searchParams.get('project');
      if (pj && UUID.test(pj)) q += `&source_project_id=eq.${pj}`;
      const r = await sb(q);
      const rows = r.ok ? await r.json() : [];
      const posts = (await attachCovers(env, rows)).map(p => ({
        ...publicPost(p), cover: p.cover, status: p.status, status_text: statusText(p.status, p.status_reason),
        source_project_id: p.source_project_id, comments_mode: p.comments_mode,
      }));
      return json({ posts });
    }

    if (id) {
      if (!UUID.test(id)) return json({ error: 'not_found' }, 404);
      const r = await sb(`/rest/v1/posts?id=eq.${id}&select=${POST_COLS}`);
      const p = (r.ok ? await r.json() : [])[0];
      const me = who.user ? who.user.id : null;
      const isOwner = !!(p && me && p.owner_id === me);
      if (!p || p.status === 'deleted') return json({ error: 'not_found' }, 404);
      // 볼 수 있는지: 내 게시물·관리자 / 공개된 게시물 중 전체 공개 또는 (팔로워만이면 수락된 팔로워), 차단 관계 제외
      let follow = null;
      if (!isOwner && !who.admin) {
        if (p.status !== 'published') return json({ error: 'not_found' }, 404);
        if (me && (await blockedIds(env, me)).includes(p.owner_id)) return json({ error: 'not_found' }, 404);
        follow = await followStatus(env, me, p.owner_id);
        if (p.visibility !== 'public' && follow !== 'accepted') return json({ error: 'not_found' }, 404);
      }
      const media = await mediaOf(env, id);
      let liked = false;
      if (me) {
        const lr = await sb(`/rest/v1/likes?post_id=eq.${id}&user_id=eq.${me}&select=post_id`);
        liked = !!(lr.ok ? await lr.json() : []).length;
      }
      const mode = p.comments_mode || 'all';
      let can_comment = !!me && p.status === 'published' && mode !== 'off' && (mode === 'all' || isOwner || follow === 'accepted');
      return json({
        ...publicPost(p), media, is_owner: isOwner, liked, comments_mode: mode, can_comment,
        comment_hint: !me ? '로그인하면 댓글을 쓸 수 있어요.' : mode === 'off' ? '이 게시물은 댓글을 받지 않아요.' : (!can_comment && mode === 'followers') ? '팔로워만 댓글을 쓸 수 있어요.' : '',
        ...(isOwner || who.admin ? { status: p.status, status_text: statusText(p.status, p.status_reason) } : {}),
      });
    }
    return json({ error: 'bad_request' }, 400);
  }

  if (!who.user) return json({ error: 'login_required' }, 401);
  if (!who.profile) return json({ error: 'profile_not_found' }, 404);

  // ── 게시 시작 ──
  if (request.method === 'POST' && !url.searchParams.get('action')) {
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const kind = String(b.kind || '');
    const title = clean(b.title, 60);
    const caption = clean(b.caption, 500);
    if (!KINDS.includes(kind) || kind === 'dub') return json({ error: 'invalid_kind' }, 400);
    if (!title) return json({ error: '제목을 적어 주세요.', code: 'title_required' }, 400);
    const visibility = b.visibility || 'public';
    const cmode = b.comments_mode || 'all';
    if (!VIS.includes(visibility)) return json({ error: '공개 범위를 다시 골라 주세요.', code: 'invalid_visibility' }, 400);
    if (!CMODES.includes(cmode)) return json({ error: '댓글 설정을 다시 골라 주세요.', code: 'invalid_comments_mode' }, 400);
    if (!Array.isArray(b.media) || b.media.length < 1 || b.media.length > 20) return json({ error: ERR.invalid_media, code: 'invalid_media' }, 400);
    const postId = crypto.randomUUID();
    const media = [];
    for (let i = 0; i < b.media.length; i++) {
      const m = b.media[i] || {};
      const bytes = Number(m.bytes), w = Number(m.width), h = Number(m.height);
      if (!MIME_EXT[m.mime] || !Number.isInteger(bytes) || bytes < 1 || bytes > 10 * 1024 * 1024 || !SHA.test(String(m.sha256 || ''))
        || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 10000 || h > 10000) {
        return json({ error: '그림 정보가 올바르지 않아요.', code: 'invalid_media' }, 400);
      }
      media.push({ idx: i, path: `${who.user.id}/${postId}/${i}-${m.sha256.slice(0, 16)}.${MIME_EXT[m.mime]}`, mime: m.mime, bytes,
        width: w, height: h, sha256: m.sha256, body: clean(m.body, 1000) });
    }
    const project = UUID.test(String(b.source_project_id || '')) ? b.source_project_id : null;
    const replaces = UUID.test(String(b.replaces_post_id || '')) ? b.replaces_post_id : null;
    const res = await rpc(env, 'social_begin_post', {
      p_owner: who.user.id, p_id: postId, p_kind: kind, p_title: title, p_caption: caption, p_visibility: visibility,
      p_project: project, p_replaces: replaces, p_media: media,
    });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (res.failed || !res.data) return json({ error: 'post_create_failed' }, 500);
    const d = res.data;
    if (Array.isArray(d.stale_paths) && d.stale_paths.length) await removeObjects(env, d.stale_paths, POST_BUCKET);
    if (!d.ok) return json({ error: ERR[d.error] || d.error, code: d.error, sanction: d.sanction || undefined }, d.error === 'sanctioned' ? 403 : d.error === 'quota_exceeded' ? 413 : 429);
    if (cmode !== 'all') await sb(`/rest/v1/posts?id=eq.${postId}&owner_id=eq.${who.user.id}`, { method: 'PATCH', body: JSON.stringify({ comments_mode: cmode }) });

    const uploads = [];
    for (const m of media) {
      const t = await signUpload(env, m.path, POST_BUCKET);
      if (!t) { await rpc(env, 'social_delete_post', { p_post: postId, p_owner: who.user.id, p_admin: false }); return json({ error: 'sign_failed' }, 500); }
      uploads.push({ idx: m.idx, path: m.path, token: t.token });
    }
    return json({ id: postId, bucket: POST_BUCKET, uploads });
  }

  // ── 게시 마무리 ──
  if (request.method === 'POST' && url.searchParams.get('action') === 'finish') {
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!UUID.test(String(b.id || ''))) return json({ error: 'not_found' }, 404);
    const pr = await sb(`/rest/v1/posts?id=eq.${b.id}&owner_id=eq.${who.user.id}&select=id,status`);
    const p = (pr.ok ? await pr.json() : [])[0];
    if (!p) return json({ error: 'not_found' }, 404);
    if (p.status === 'uploading') {
      const mr = await sb(`/rest/v1/post_media?post_id=eq.${b.id}&select=path,bytes`);
      const rows = mr.ok ? await mr.json() : [];
      for (const m of rows) {
        const info = await objectInfo(env, m.path, POST_BUCKET);
        const size = info && Number(info.size != null ? info.size : (info.metadata && info.metadata.size));
        if (!info || size !== Number(m.bytes)) {
          const del = await rpc(env, 'social_delete_post', { p_post: b.id, p_owner: who.user.id, p_admin: false });
          await removeObjects(env, (del.data && del.data.paths) || rows.map(x => x.path), POST_BUCKET);
          return json({ error: '그림이 다 올라가지 않았어요. 다시 게시해 주세요.', code: 'upload_incomplete' }, 400);
        }
      }
    }
    const res = await rpc(env, 'social_finish_post', { p_owner: who.user.id, p_post: b.id });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (res.failed || !res.data || !res.data.ok) return json({ error: 'finish_failed' }, 500);
    if (Array.isArray(res.data.old_paths) && res.data.old_paths.length) await removeObjects(env, res.data.old_paths, POST_BUCKET);
    return json({ id: b.id, status: res.data.status, status_text: statusText(res.data.status) });
  }

  // ── 고치기 ──
  if (request.method === 'PATCH') {
    if (!UUID.test(String(id || ''))) return json({ error: 'not_found' }, 404);
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const pr = await sb(`/rest/v1/posts?id=eq.${id}&owner_id=eq.${who.user.id}&status=in.(pending,published,rejected)&select=id,status`);
    const p = (pr.ok ? await pr.json() : [])[0];
    if (!p) return json({ error: 'not_found' }, 404);
    const patch = { updated_at: new Date().toISOString() };
    if ('title' in b) { const t = clean(b.title, 60); if (!t) return json({ error: '제목을 적어 주세요.', code: 'title_required' }, 400); patch.title = t; }
    if ('caption' in b) patch.caption = clean(b.caption, 500) || null;
    if ('visibility' in b) { if (!VIS.includes(b.visibility)) return json({ error: 'invalid_visibility' }, 400); patch.visibility = b.visibility; }
    if ('comments_mode' in b) { if (!CMODES.includes(b.comments_mode)) return json({ error: 'invalid_comments_mode' }, 400); patch.comments_mode = b.comments_mode; }
    // 승인 모드에서는 제목·소개를 고치면 다시 확인받는다 (공개 범위·댓글 설정만 바꾸면 그대로)
    const contentChanged = 'title' in patch || 'caption' in patch;
    if (contentChanged) {
      const sr = await sb('/rest/v1/social_settings?id=eq.1&select=require_approval');
      const needApproval = ((sr.ok ? await sr.json() : [])[0] || { require_approval: true }).require_approval;
      if (needApproval && (p.status === 'published' || p.status === 'rejected')) { patch.status = 'pending'; patch.published_at = null; patch.status_reason = null; }
    }
    const r = await sb(`/rest/v1/posts?id=eq.${id}&owner_id=eq.${who.user.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    if (!r.ok) return json({ error: 'update_failed' }, 500);
    const status = patch.status || p.status;
    return json({ ok: true, status, status_text: statusText(status) });
  }

  // ── 삭제 ──
  if (request.method === 'DELETE') {
    if (!UUID.test(String(id || ''))) return json({ error: 'not_found' }, 404);
    const res = await rpc(env, 'social_delete_post', { p_post: id, p_owner: who.user.id, p_admin: false });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (!res.data || !res.data.ok) return json({ error: 'not_found' }, 404);
    await removeObjects(env, res.data.paths || [], POST_BUCKET);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
