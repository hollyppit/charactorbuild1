// 관리자 전용 이미지 업로드 (char-assets 버킷)
import { corsHeaders, jsonResponder, checkOrigin, checkSize, isAdmin, supabaseKey } from './_lib/common.js';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export async function onRequest(context) {
  const { request, env } = context;
  const cors = corsHeaders(request, env, 'POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const bad = checkOrigin(request, env, cors) || checkSize(request, Math.ceil(MAX_BYTES * 1.4), cors);
  if (bad) return bad;
  if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const { fileName, fileData } = body;
  const m = /^data:([a-z/+.-]+);base64,(.+)$/s.exec(String(fileData || ''));
  if (!m || !ALLOWED[m[1]]) return json({ error: 'invalid_file_type' }, 400);
  // 경로 조작 방지: 하위 폴더(a/b.png)는 허용하되 각 구간을 영숫자·_-. 로 제한하고 '.'로 시작하는 구간은 제외
  const safeName = String(fileName || '').split('/')
    .map(seg => seg.replace(/[^A-Za-z0-9_.-]/g, '_'))
    .filter(seg => seg && !seg.startsWith('.'))
    .join('/').slice(0, 160);
  if (!safeName) return json({ error: 'invalid_file_name' }, 400);

  let binary;
  try { binary = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)); } catch { return json({ error: 'invalid_base64' }, 400); }
  if (binary.length > MAX_BYTES) return json({ error: 'file_too_large' }, 413);

  const key = supabaseKey(env);
  const uploadRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/char-assets/${safeName}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': m[1], 'x-upsert': 'true' },
    body: binary,
  });
  if (!uploadRes.ok) {
    return json({ error: await uploadRes.text() }, 400);
  }
  return json({ url: `${env.SUPABASE_URL}/storage/v1/object/public/char-assets/${safeName}` });
}
