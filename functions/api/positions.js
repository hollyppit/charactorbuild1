import { corsHeaders, jsonResponder, checkOrigin, checkSize, isAdmin, makeSb } from './_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const bad = checkOrigin(request, env, cors);
  if (bad) return bad;
  const sb = makeSb(env);

  if (request.method === 'GET') {
    const res = await sb('/rest/v1/char_positions');
    return json(await res.json(), res.status);
  }
  if (request.method === 'POST') {
    if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);
    const big = checkSize(request, 64 * 1024, cors);
    if (big) return big;
    const body = await request.json();
    const res = await sb('/rest/v1/char_positions', {
      method: 'POST',
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify(body),
    });
    return json(await res.json(), res.status);
  }
  return json({ error: 'method_not_allowed' }, 405);
}
