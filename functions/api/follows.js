// 팔로우
//  GET  /api/follows?list=followers|following|requests   내 목록 (requests = 나에게 온 팔로우 요청)
//  POST /api/follows {action, nickname}
//    follow (전체 공개면 바로, 아니면 요청) / unfollow (요청 취소 포함) / accept / reject / remove (내 팔로워 내보내기)
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, rpc } from './_lib/social.js';

const NICK_RE = /^[0-9A-Za-z가-힣_]{2,20}$/;

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 2048, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: '로그인이 필요해요.', code: 'login_required' }, 401);
  const me = who.user.id;
  const sb = makeSb(env);

  if (request.method === 'GET') {
    const list = new URL(request.url).searchParams.get('list');
    let q;
    if (list === 'followers') q = `/rest/v1/follows?followee_id=eq.${me}&status=eq.accepted&select=created_at,user:profiles!follows_follower_id_fkey(nickname,avatar_url)`;
    else if (list === 'following') q = `/rest/v1/follows?follower_id=eq.${me}&select=status,created_at,user:profiles!follows_followee_id_fkey(nickname,avatar_url)`;
    else if (list === 'requests') q = `/rest/v1/follows?followee_id=eq.${me}&status=eq.pending&select=created_at,user:profiles!follows_follower_id_fkey(nickname,avatar_url)`;
    else return json({ error: 'bad_request' }, 400);
    const r = await sb(q + '&order=created_at.desc&limit=500');
    if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
    const rows = r.ok ? await r.json() : [];
    return json({ users: rows.filter(x => x.user).map(x => ({ nickname: x.user.nickname, avatar_url: x.user.avatar_url || null, status: x.status || 'accepted', since: x.created_at })) });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const n = String(b.nickname || '').trim();
  if (!NICK_RE.test(n)) return json({ error: '사람을 찾을 수 없어요.', code: 'not_found' }, 404);
  const pr = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(n)}&select=id`);
  const other = ((pr.ok ? await pr.json() : [])[0] || {}).id;
  if (!other) return json({ error: '사람을 찾을 수 없어요.', code: 'not_found' }, 404);

  const a = String(b.action || '');
  if (a === 'follow') {
    const res = await rpc(env, 'social_follow', { p_follower: me, p_followee: other });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (!res.data || !res.data.ok) return json({ error: res.data && res.data.error === 'self' ? '나 자신은 팔로우할 수 없어요.' : '팔로우할 수 없어요.', code: (res.data && res.data.error) || 'failed' }, 400);
    return json({ ok: true, status: res.data.status });
  }
  if (a === 'unfollow') {
    await sb(`/rest/v1/follows?follower_id=eq.${me}&followee_id=eq.${other}`, { method: 'DELETE' });
    return json({ ok: true, status: null });
  }
  if (a === 'accept' || a === 'reject') {
    const res = await rpc(env, 'social_follow_respond', { p_followee: me, p_follower: other, p_accept: a === 'accept' });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (!res.data || !res.data.ok) return json({ error: '요청을 찾을 수 없어요.', code: 'not_found' }, 404);
    return json({ ok: true });
  }
  if (a === 'remove') {
    await sb(`/rest/v1/follows?follower_id=eq.${other}&followee_id=eq.${me}`, { method: 'DELETE' });
    return json({ ok: true });
  }
  return json({ error: 'unknown_action' }, 400);
}
