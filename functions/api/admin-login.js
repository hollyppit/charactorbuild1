// 관리자 비밀번호 서버 검증. 클라이언트는 비밀번호의 SHA-256 해시를 보내고,
// 맞으면 이후 요청에 X-Admin-Hash 헤더로 같은 해시를 실어 보낸다.
import { corsHeaders, jsonResponder, checkOrigin, checkSize, timingSafeEqual } from './_lib/common.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const bad = checkOrigin(request, env, cors) || checkSize(request, 2048, cors);
  if (bad) return bad;

  const expected = String(env.ADMIN_PW_HASH || '').toLowerCase();
  if (!expected) return json({ error: 'admin_disabled' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const hash = String(body.hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash) || !timingSafeEqual(hash, expected)) {
    return json({ ok: false }, 403);
  }
  return json({ ok: true });
}
