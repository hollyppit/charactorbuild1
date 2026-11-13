// 작업 이미지/음성 파일 업로드 (서버가 검사한 뒤 서명 토큰을 발급, 브라우저가 스토리지에 직접 업로드)
//  POST /api/assets                 {project_id, sha256, mime, bytes} → {exists} 또는 {asset_id, path, token}
//  POST /api/assets?action=confirm  {asset_id}                        → 업로드 완료 확인 (크기 일치 검사)
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { getUser } from './_lib/auth.js';
import { signUpload, objectInfo, removeObjects, BUCKET } from './_lib/storage.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  // 그림책 더빙 장면 동영상 (0007 마이그레이션으로 버킷 허용 형식에 추가)
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const bad = checkOrigin(request, env, cors) || checkSize(request, 4096, cors);
  if (bad) return bad;

  const user = await getUser(request, env);
  if (!user) return json({ error: 'login_required' }, 401);
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const sb = makeSb(env);
  const action = new URL(request.url).searchParams.get('action') || '';
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const own = `owner_id=eq.${encodeURIComponent(user.id)}`;
  const release = bytes => sb('/rest/v1/rpc/release_quota', { method: 'POST', body: JSON.stringify({ p_owner: user.id, p_bytes: bytes }) });

  // ── 업로드 완료 확인 ──
  if (action === 'confirm') {
    if (!UUID.test(String(b.asset_id || ''))) return json({ error: 'invalid_asset' }, 400);
    const r = await sb(`/rest/v1/project_assets?id=eq.${b.asset_id}&${own}&select=id,path,bytes,status`);
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return json({ error: 'not_found' }, 404);
    const a = rows[0];
    if (a.status === 'ready') return json({ ok: true, asset_id: a.id });
    const info = await objectInfo(env, a.path);
    const size = info && Number(info.size != null ? info.size : (info.metadata && info.metadata.size));
    if (!info || size !== Number(a.bytes)) {
      // 업로드가 없거나 선언한 크기와 다르면 폐기하고 용량 반환
      await removeObjects(env, [a.path]);
      await sb(`/rest/v1/project_assets?id=eq.${a.id}&${own}`, { method: 'DELETE' });
      await release(a.bytes);
      return json({ error: info ? 'size_mismatch' : 'upload_missing' }, 400);
    }
    await sb(`/rest/v1/project_assets?id=eq.${a.id}&${own}`, { method: 'PATCH', body: JSON.stringify({ status: 'ready' }) });
    return json({ ok: true, asset_id: a.id });
  }

  // ── 업로드 준비 ──
  const bytes = b.bytes;
  if (!UUID.test(String(b.project_id || ''))) return json({ error: 'invalid_project' }, 400);
  if (!SHA.test(String(b.sha256 || ''))) return json({ error: 'invalid_sha256' }, 400);
  if (!MIME_EXT[b.mime]) return json({ error: 'invalid_mime' }, 400);
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) return json({ error: 'invalid_size' }, 400);

  const pr = await sb(`/rest/v1/projects?id=eq.${b.project_id}&${own}&deleted_at=is.null&select=id`);
  if (pr.status === 404 || pr.status === 400) return json({ error: 'projects_not_ready' }, 503);
  if (!pr.ok || !(await pr.json()).length) return json({ error: 'project_not_found' }, 404);

  const path = `${user.id}/${b.project_id}/${b.sha256}.${MIME_EXT[b.mime]}`;
  const ex = await sb(`/rest/v1/project_assets?project_id=eq.${b.project_id}&sha256=eq.${b.sha256}&${own}&select=id,status,path`);
  const exRows = ex.ok ? await ex.json() : [];
  if (exRows.length) {
    if (exRows[0].status === 'ready') return json({ exists: true, asset_id: exRows[0].id }); // 같은 이미지는 다시 올리지 않음
    const t = await signUpload(env, exRows[0].path);        // 이전에 끊긴 업로드 재개 (용량은 이미 예약됨)
    return t ? json({ asset_id: exRows[0].id, path: exRows[0].path, token: t.token, bucket: BUCKET }) : json({ error: 'sign_failed' }, 500);
  }

  const rq = await sb('/rest/v1/rpc/reserve_quota', { method: 'POST', body: JSON.stringify({ p_owner: user.id, p_bytes: bytes }) });
  if (!rq.ok) return json({ error: 'quota_error' }, 500);
  if ((await rq.json()) !== true) return json({ error: 'quota_exceeded' }, 413);

  const ins = await sb('/rest/v1/project_assets', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ project_id: b.project_id, owner_id: user.id, path, mime: b.mime, bytes, sha256: b.sha256 }),
  });
  const insRows = await ins.json().catch(() => null);
  if (!ins.ok) { await release(bytes); return json({ error: 'asset_create_failed' }, 500); }
  const t = await signUpload(env, path);
  if (!t) { await sb(`/rest/v1/project_assets?id=eq.${insRows[0].id}&${own}`, { method: 'DELETE' }); await release(bytes); return json({ error: 'sign_failed' }, 500); }
  return json({ asset_id: insRows[0].id, path, token: t.token, bucket: BUCKET });
}
