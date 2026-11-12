// AI 접근 비밀번호 서버 검증 (비밀번호 값 자체는 클라이언트에 내려주지 않는다)
import { corsHeaders, jsonResponder, checkOrigin, checkSize, getAiAccessPw, timingSafeEqual } from './_lib/common.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const bad = checkOrigin(request, env, cors) || checkSize(request, 2048, cors);
  if (bad) return bad;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const pw = await getAiAccessPw(env);
  if (pw === null) return json({ error: 'gate_unavailable' }, 503);
  if (!pw) return json({ ok: true });
  return timingSafeEqual(String(body.pw || ''), pw) ? json({ ok: true }) : json({ ok: false }, 403);
}
