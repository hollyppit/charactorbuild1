// 좋아요
//  POST /api/likes {post_id, on:true|false}   → {liked, like_count}
//  GET  /api/likes?post=uuid                  게시물 주인만: 누가 좋아했는지 (차단 관계 제외)
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, rpc, blockedIds, UUID } from './_lib/social.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 2048, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: '로그인하면 좋아요를 누를 수 있어요.', code: 'login_required' }, 401);
  const sb = makeSb(env);

  if (request.method === 'GET') {
    const post = new URL(request.url).searchParams.get('post');
    if (!UUID.test(String(post || ''))) return json({ error: 'not_found' }, 404);
    const pr = await sb(`/rest/v1/posts?id=eq.${post}&owner_id=eq.${who.user.id}&select=id`);
    if (!(pr.ok ? await pr.json() : []).length) return json({ error: 'not_found' }, 404);
    const blocked = new Set(await blockedIds(env, who.user.id));
    const r = await sb(`/rest/v1/likes?post_id=eq.${post}&select=created_at,user_id,user:profiles!likes_user_id_fkey(nickname,avatar_url)&order=created_at.desc&limit=500`);
    const rows = r.ok ? await r.json() : [];
    return json({ users: rows.filter(x => x.user && !blocked.has(x.user_id)).map(x => ({ nickname: x.user.nickname, avatar_url: x.user.avatar_url || null })) });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!UUID.test(String(b.post_id || ''))) return json({ error: 'not_found' }, 404);
  const res = await rpc(env, 'social_like', { p_user: who.user.id, p_post: b.post_id, p_on: !!b.on });
  if (res.missing) return json({ error: 'social_not_ready' }, 503);
  if (!res.data || !res.data.ok) return json({ error: '게시물을 찾을 수 없어요.', code: 'not_found' }, 404);
  return json({ liked: res.data.liked, like_count: res.data.like_count });
}
