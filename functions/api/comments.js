// 댓글
//  GET    /api/comments?post=uuid[&before=ISO]   보이는 댓글(오래된 순 100개, 차단 관계 제외)
//  POST   /api/comments {post_id, body}          300자, 욕설 확인, 1시간 개수 제한
//  DELETE /api/comments?id=uuid                  쓴 사람 또는 게시물 주인
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, rpc, blockedIds, notInList, UUID } from './_lib/social.js';
import { hasBadWord } from './_lib/words.js';

const ERR = {
  sanctioned: '지금은 댓글을 쓸 수 없어요 (이용 제한 중). 자세한 내용은 마이페이지에서 확인해 주세요.',
  comments_off: '이 게시물은 댓글을 받지 않아요.',
  followers_only: '이 게시물은 팔로워만 댓글을 쓸 수 있어요.',
  comment_limit: '댓글을 너무 많이 썼어요. 조금 뒤에 다시 써 주세요.',
  not_found: '게시물을 찾을 수 없어요.',
};

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,DELETE,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 4096, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  const sb = makeSb(env);
  const url = new URL(request.url);
  const me = who.user ? who.user.id : null;

  if (request.method === 'GET') {
    const post = url.searchParams.get('post');
    if (!UUID.test(String(post || ''))) return json({ error: 'not_found' }, 404);
    // 게시물을 볼 수 있는 사람만 (비회원은 공개 게시물)
    const pr = await sb(`/rest/v1/posts?id=eq.${post}&select=id,owner_id,status,visibility,comments_mode`);
    const p = (pr.ok ? await pr.json() : [])[0];
    if (!p) return json({ error: 'not_found' }, 404);
    if (!(who.admin || p.owner_id === me)) {
      if (me) {
        const v = await rpc(env, 'social_can_view_post', { p_viewer: me, p_post: post });
        if (v.data !== true) return json({ error: 'not_found' }, 404);
      } else if (!(p.status === 'published' && p.visibility === 'public')) return json({ error: 'not_found' }, 404);
    }
    const blocked = await blockedIds(env, me);
    const before = url.searchParams.get('before');
    let q = `/rest/v1/comments?post_id=eq.${post}&status=eq.visible${notInList('author_id', blocked)}&select=id,body,created_at,author_id,author:profiles!comments_author_id_fkey(nickname,avatar_url)&order=created_at.asc&limit=100`;
    if (before && !isNaN(Date.parse(before))) q += `&created_at=gt.${encodeURIComponent(new Date(before).toISOString())}`;
    const r = await sb(q);
    if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
    const rows = r.ok ? await r.json() : [];
    return json({
      comments: rows.map(c => ({
        id: c.id, body: c.body, created_at: c.created_at,
        author: { nickname: (c.author || {}).nickname || '', avatar_url: (c.author || {}).avatar_url || null },
        can_delete: !!me && (c.author_id === me || p.owner_id === me), is_mine: c.author_id === me,
      })),
      next: rows.length === 100 ? rows[rows.length - 1].created_at : null,
      comments_mode: p.comments_mode,
    });
  }

  if (!who.user || !who.profile) return json({ error: '로그인하면 댓글을 쓸 수 있어요.', code: 'login_required' }, 401);

  if (request.method === 'POST') {
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!UUID.test(String(b.post_id || ''))) return json({ error: ERR.not_found, code: 'not_found' }, 404);
    const body = String(b.body || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (!body) return json({ error: '댓글을 적어 주세요.', code: 'empty' }, 400);
    if (body.length > 300) return json({ error: '댓글은 300자까지 쓸 수 있어요.', code: 'too_long' }, 400);
    if (hasBadWord(body)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    const res = await rpc(env, 'social_comment', { p_user: me, p_post: b.post_id, p_body: body });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (!res.data) return json({ error: 'comment_failed' }, 500);
    if (!res.data.ok) {
      const code = res.data.error;
      return json({ error: ERR[code] || code, code }, code === 'comment_limit' ? 429 : code === 'not_found' ? 404 : 403);
    }
    return json({ ok: true, id: res.data.id });
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!UUID.test(String(id || ''))) return json({ error: 'not_found' }, 404);
    const res = await rpc(env, 'social_delete_comment', { p_actor: me, p_comment: id, p_admin: false });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (!res.data || !res.data.ok) return json({ error: '댓글을 찾을 수 없어요.', code: 'not_found' }, 404);
    return json({ ok: true });
  }
  return json({ error: 'method_not_allowed' }, 405);
}
