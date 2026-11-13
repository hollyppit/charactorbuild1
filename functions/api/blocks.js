// 차단
//  GET  /api/blocks                     내가 차단한 사람 목록
//  POST /api/blocks {action:'block'|'unblock', nickname}
//  차단하면 서로 팔로우가 끊기고, 서로의 게시물·댓글·프로필이 보이지 않으며, 팔로우·댓글·좋아요를 할 수 없다. 상대에게 알리지 않는다.
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
    const r = await sb(`/rest/v1/blocks?blocker_id=eq.${me}&select=created_at,user:profiles!blocks_blocked_id_fkey(nickname,avatar_url)&order=created_at.desc&limit=500`);
    if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
    const rows = r.ok ? await r.json() : [];
    return json({ users: rows.filter(x => x.user).map(x => ({ nickname: x.user.nickname, avatar_url: x.user.avatar_url || null, since: x.created_at })) });
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const n = String(b.nickname || '').trim();
  if (!NICK_RE.test(n)) return json({ error: '사람을 찾을 수 없어요.', code: 'not_found' }, 404);
  const pr = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(n)}&select=id`);
  const other = ((pr.ok ? await pr.json() : [])[0] || {}).id;
  if (!other || other === me) return json({ error: '사람을 찾을 수 없어요.', code: 'not_found' }, 404);

  if (b.action === 'block') {
    const res = await rpc(env, 'social_block', { p_blocker: me, p_blocked: other });
    if (res.missing) return json({ error: 'social_not_ready' }, 503);
    if (!res.data || !res.data.ok) return json({ error: '차단하지 못했어요.' }, 400);
    return json({ ok: true });
  }
  if (b.action === 'unblock') {
    await sb(`/rest/v1/blocks?blocker_id=eq.${me}&blocked_id=eq.${other}`, { method: 'DELETE' });
    return json({ ok: true });
  }
  return json({ error: 'unknown_action' }, 400);
}
