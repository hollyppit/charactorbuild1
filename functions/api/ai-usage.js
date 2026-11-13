// AI 사용량 조회·한도 설정
//  GET  /api/ai-usage                  회원: 오늘 내 사용량 {day, used, limit, cost}
//  GET  /api/ai-usage?admin=1&days=14  관리자: 날짜별 합계·많이 쓴 회원·현재 한도
//  POST /api/ai-usage?action=limits    관리자: {member_daily, guest_ip_daily, guest_total_daily}
import { corsHeaders, jsonResponder, checkOrigin, checkSize, isAdmin, makeSb } from './_lib/common.js';
import { getUser } from './_lib/auth.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 2048, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);

  const sb = makeSb(env);
  const url = new URL(request.url);
  const rpc = async (fn, args) => {
    const r = await sb('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });
    if (r.status === 404) return { missing: true };
    if (!r.ok) return { failed: true };
    return { data: await r.json() };
  };
  const out = r => r.missing ? json({ error: 'usage_not_ready' }, 503) : r.failed ? json({ error: 'usage_error' }, 500) : json(r.data);

  if (request.method === 'GET' && url.searchParams.get('admin') === '1') {
    if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '14', 10) || 14));
    return out(await rpc('ai_admin_summary', { p_days: days }));
  }

  if (request.method === 'POST' && url.searchParams.get('action') === 'limits') {
    if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const n = v => { const x = Number(v); return Number.isInteger(x) && x >= 0 && x <= 1000000 ? x : null; };
    const m = n(b.member_daily), gi = n(b.guest_ip_daily), gt = n(b.guest_total_daily);
    if (m == null || gi == null || gt == null) return json({ error: 'invalid_limits' }, 400);
    return out(await rpc('ai_set_limits', { p_member: m, p_guest_ip: gi, p_guest_total: gt }));
  }

  if (request.method === 'GET') {
    const user = await getUser(request, env);
    if (!user) return json({ error: 'login_required' }, 401);
    return out(await rpc('ai_my_usage', { p_owner: user.id }));
  }
  return json({ error: 'method_not_allowed' }, 405);
}
