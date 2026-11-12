import { corsHeaders, jsonResponder, checkOrigin, checkSize, isAdmin, makeSb } from './_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  const cors = corsHeaders(request, env, 'GET,POST,PUT,DELETE,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const bad = checkOrigin(request, env, cors);
  if (bad) return bad;
  const sb = makeSb(env);
  const prefer = { Prefer: 'return=representation,resolution=merge-duplicates' };

  if (request.method === 'GET') {
    const res = await sb('/rest/v1/char_items?order=category,sort_order');
    const data = await res.json();
    if (!Array.isArray(data)) return json(data, res.status);
    // AI 접근 비밀번호 값은 관리자에게만 전달 (일반 사용자에게는 "설정됨" 표식만)
    if (!isAdmin(request, env)) {
      for (const r of data) {
        if (r.id === 'ai_access_pw' && r.label) r.label = '*';
      }
    }
    return json(data);
  }

  // 이하 쓰기 작업은 관리자 전용
  if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);
  const big = checkSize(request, 3 * 1024 * 1024, cors);
  if (big) return big;

  if (request.method === 'POST') {
    const body = await request.json();
    const res = await sb('/rest/v1/char_items', {
      method: 'POST', headers: prefer, body: JSON.stringify(body)
    });
    return json(await res.json(), res.status);
  }
  if (request.method === 'PUT') {
    const body = await request.json();
    const { id, ...rest } = body;
    if (!id) return json({ error: 'missing_id' }, 400);
    const res = await sb(`/rest/v1/char_items?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: prefer, body: JSON.stringify(rest)
    });
    return json(await res.json(), res.status);
  }
  if (request.method === 'DELETE') {
    const { id } = await request.json();
    if (!id) return json({ error: 'missing_id' }, 400);
    await sb(`/rest/v1/char_items?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return json({ ok: true });
  }
  return json({ error: 'method_not_allowed' }, 405);
}
