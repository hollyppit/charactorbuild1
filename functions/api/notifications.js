// 알림 (앱 안에서만, 90일 보관)
//  GET  /api/notifications?count=1        읽지 않은 개수만 {unread}
//  GET  /api/notifications                최근 50개 + 읽지 않은 개수 (차단 관계인 사람의 알림 제외)
//  POST /api/notifications {action:'read_all'}
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, blockedIds } from './_lib/social.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 1024, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: 'login_required' }, 401);
  const me = who.user.id;
  const sb = makeSb(env);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('count') === '1') {
      const r = await sb(`/rest/v1/notifications?user_id=eq.${me}&read_at=is.null&select=id&limit=100`);
      if (r.status === 404 || r.status === 400) return json({ unread: 0 });
      return json({ unread: (r.ok ? await r.json() : []).length });
    }
    const blocked = new Set(await blockedIds(env, me));
    const r = await sb(`/rest/v1/notifications?user_id=eq.${me}&select=id,type,data,read_at,created_at,post_id,comment_id,actor_id,actor:profiles!notifications_actor_id_fkey(nickname,avatar_url),post:posts(title)&order=created_at.desc&limit=50`);
    if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
    const rows = (r.ok ? await r.json() : []).filter(n => !n.actor_id || !blocked.has(n.actor_id));
    return json({
      unread: rows.filter(n => !n.read_at).length,
      notifications: rows.map(n => ({
        id: n.id, type: n.type, read: !!n.read_at, created_at: n.created_at, post_id: n.post_id,
        actor: n.actor ? { nickname: n.actor.nickname, avatar_url: n.actor.avatar_url || null } : null,
        post_title: n.post ? n.post.title : null, data: n.data || null,
      })),
    });
  }
  if (request.method === 'POST') {
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (b.action !== 'read_all') return json({ error: 'unknown_action' }, 400);
    await sb(`/rest/v1/notifications?user_id=eq.${me}&read_at=is.null`, { method: 'PATCH', body: JSON.stringify({ read_at: new Date().toISOString() }) });
    return json({ ok: true });
  }
  return json({ error: 'method_not_allowed' }, 405);
}
