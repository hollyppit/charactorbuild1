// 내 작업(프로젝트) 목록·열기·저장·휴지통. 로그인(JWT) 필수, 본인 작업만 다룬다.
//  GET    /api/projects                 목록 (?kind=, ?trashed=1)  + 용량
//  GET    /api/projects?id=             열기 (이미지는 1시간짜리 서명 주소)
//  POST   /api/projects                 만들기 {kind,title,data?,child_id?}
//  PUT    /api/projects?id=             저장 {expected_version,title?,data,thumb_asset?}  → 충돌 시 409
//  DELETE /api/projects?id=             휴지통으로 (?purge=1 이면 영구 삭제: 휴지통에 있는 작업만)
//  POST   /api/projects?action=restore&id=   휴지통에서 복구
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { getUser } from './_lib/auth.js';
import { signDownloads, removeObjects } from './_lib/storage.js';

const KINDS = ['draw', 'story', 'character', 'storyboard', 'dub'];
const MAX_BODY = 1.2 * 1024 * 1024;      // data(JSON) 약 1MB. 큰 이미지는 /api/assets 로 별도 업로드
const MAX_PROJECTS = 500;
const TRASH_DAYS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_COLS = 'id,kind,title,child_id,thumb_asset,version,size_bytes,created_at,updated_at,deleted_at';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,PUT,DELETE,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, MAX_BODY, cors);
  if (bad) return bad;

  const user = await getUser(request, env);
  if (!user) return json({ error: 'login_required' }, 401);
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const sb = makeSb(env);
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  const action = url.searchParams.get('action') || '';
  if (id && !UUID.test(id)) return json({ error: 'invalid_id' }, 400);
  const own = `owner_id=eq.${encodeURIComponent(user.id)}`;

  // 테이블이 아직 없으면(마이그레이션 전) 503
  const notReady = r => r.status === 404 || r.status === 400 ? json({ error: 'projects_not_ready' }, 503) : null;

  // 휴지통 30일 경과 작업 정리 (접근 시 소량씩)
  async function purgeExpired() {
    const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
    const r = await sb(`/rest/v1/projects?${own}&deleted_at=lt.${encodeURIComponent(cutoff)}&select=id&limit=5`);
    const rows = r.ok ? await r.json() : [];
    for (const p of Array.isArray(rows) ? rows : []) await purgeProject(p.id);
  }
  async function purgeProject(pid) {
    const a = await sb(`/rest/v1/project_assets?project_id=eq.${pid}&${own}&select=path,bytes`);
    const assets = a.ok ? await a.json() : [];
    await removeObjects(env, assets.map(x => x.path));
    const total = assets.reduce((s, x) => s + Number(x.bytes || 0), 0);
    await sb(`/rest/v1/projects?id=eq.${pid}&${own}`, { method: 'DELETE' }); // assets·versions 는 CASCADE
    if (total) await sb('/rest/v1/rpc/release_quota', { method: 'POST', body: JSON.stringify({ p_owner: user.id, p_bytes: total }) });
  }

  // ── 목록 / 열기 ────────────────────────────────────────
  if (request.method === 'GET') {
    if (id) {
      const r = await sb(`/rest/v1/projects?id=eq.${id}&${own}&select=*`);
      const nr = notReady(r); if (nr) return nr;
      const rows = await r.json();
      if (!rows.length) return json({ error: 'not_found' }, 404);
      const a = await sb(`/rest/v1/project_assets?project_id=eq.${id}&status=eq.ready&select=id,path,mime,bytes`);
      const assets = a.ok ? await a.json() : [];
      const urls = await signDownloads(env, assets.map(x => x.path));
      const map = {};
      for (const x of assets) if (urls[x.path]) map[x.id] = { url: urls[x.path], mime: x.mime, bytes: x.bytes };
      return json({ project: rows[0], assets: map });
    }
    await purgeExpired();
    const trashed = url.searchParams.get('trashed') === '1';
    const kind = url.searchParams.get('kind');
    let q = `/rest/v1/projects?${own}&select=${LIST_COLS}&order=updated_at.desc&limit=200&deleted_at=${trashed ? 'not.is.null' : 'is.null'}`;
    if (kind) { if (!KINDS.includes(kind)) return json({ error: 'invalid_kind' }, 400); q += `&kind=eq.${kind}`; }
    const r = await sb(q);
    const nr = notReady(r); if (nr) return nr;
    const rows = await r.json();
    // 썸네일 서명 주소
    const thumbIds = rows.map(p => p.thumb_asset).filter(Boolean);
    let thumbs = {};
    if (thumbIds.length) {
      const a = await sb(`/rest/v1/project_assets?${own}&id=in.(${thumbIds.join(',')})&select=id,path`);
      const arows = a.ok ? await a.json() : [];
      const urls = await signDownloads(env, arows.map(x => x.path));
      for (const x of arows) thumbs[x.id] = urls[x.path] || null;
    }
    const qr = await sb(`/rest/v1/user_quota?owner_id=eq.${encodeURIComponent(user.id)}&select=bytes_used,limit_bytes`);
    const qrows = qr.ok ? await qr.json() : [];
    const quota = qrows[0] || { bytes_used: 0, limit_bytes: 524288000 };
    return json({
      projects: rows.map(p => ({ ...p, thumb_url: p.thumb_asset ? thumbs[p.thumb_asset] || null : null })),
      quota, trash_days: TRASH_DAYS,
    });
  }

  // ── 복구 ──────────────────────────────────────────────
  if (request.method === 'POST' && action === 'restore') {
    if (!id) return json({ error: 'missing_id' }, 400);
    const r = await sb(`/rest/v1/projects?id=eq.${id}&${own}&deleted_at=not.is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ deleted_at: null }),
    });
    const rows = r.ok ? await r.json() : [];
    return rows.length ? json({ ok: true }) : json({ error: 'not_found' }, 404);
  }

  // ── 만들기 ────────────────────────────────────────────
  if (request.method === 'POST') {
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!KINDS.includes(b.kind)) return json({ error: 'invalid_kind' }, 400);
    const title = String(b.title || '').trim().slice(0, 100);
    if (b.data != null && (typeof b.data !== 'object' || Array.isArray(b.data))) return json({ error: 'invalid_data' }, 400);
    let child_id = null;
    if (b.child_id) {
      if (env.CHILD_PROFILES_ENABLED !== 'true' || !UUID.test(String(b.child_id))) return json({ error: 'invalid_child' }, 400);
      const c = await sb(`/rest/v1/child_profiles?id=eq.${b.child_id}&guardian_id=eq.${encodeURIComponent(user.id)}&deleted_at=is.null&select=id`);
      if (!c.ok || !(await c.json()).length) return json({ error: 'invalid_child' }, 400);
      child_id = b.child_id;
    }
    const cnt = await sb(`/rest/v1/projects?${own}&deleted_at=is.null&select=id&limit=${MAX_PROJECTS + 1}`);
    const nr = notReady(cnt); if (nr) return nr;
    if ((await cnt.json()).length >= MAX_PROJECTS) return json({ error: 'project_limit' }, 409);
    const data = b.data || {};
    const r = await sb('/rest/v1/projects', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ owner_id: user.id, child_id, kind: b.kind, title, data, size_bytes: JSON.stringify(data).length }),
    });
    const rows = await r.json().catch(() => null);
    if (!r.ok) return json({ error: 'create_failed' }, 500);
    return json(rows[0], 201);
  }

  // ── 저장 (충돌 방지) ──────────────────────────────────
  if (request.method === 'PUT') {
    if (!id) return json({ error: 'missing_id' }, 400);
    let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!Number.isInteger(b.expected_version) || b.expected_version < 1) return json({ error: 'expected_version_required' }, 400);
    if (b.data == null || typeof b.data !== 'object' || Array.isArray(b.data)) return json({ error: 'invalid_data' }, 400);
    if (b.thumb_asset != null && !UUID.test(String(b.thumb_asset))) return json({ error: 'invalid_thumb' }, 400);
    const title = 'title' in b ? String(b.title || '').trim().slice(0, 100) : null;
    if (b.thumb_asset) {
      // 썸네일은 이 작업에 속한, 업로드가 끝난 본인 파일이어야 함
      const t = await sb(`/rest/v1/project_assets?id=eq.${b.thumb_asset}&project_id=eq.${id}&${own}&status=eq.ready&select=id`);
      if (!t.ok || !(await t.json()).length) return json({ error: 'invalid_thumb' }, 400);
    }
    const r = await sb('/rest/v1/rpc/save_project', {
      method: 'POST',
      body: JSON.stringify({ p_id: id, p_owner: user.id, p_expected: b.expected_version, p_title: title, p_data: b.data, p_thumb: b.thumb_asset || null }),
    });
    const nr = notReady(r); if (nr) return nr;
    if (!r.ok) return json({ error: 'save_failed' }, 500);
    const v = await r.json();
    if (v === -1) return json({ error: 'not_found' }, 404);
    if (v === -2) {
      const cur = await sb(`/rest/v1/projects?id=eq.${id}&${own}&select=version,updated_at`);
      const c = cur.ok ? (await cur.json())[0] : null;
      return json({ error: 'version_conflict', current_version: c && c.version, updated_at: c && c.updated_at }, 409);
    }
    return json({ ok: true, version: v });
  }

  // ── 휴지통 / 영구 삭제 ────────────────────────────────
  if (request.method === 'DELETE') {
    if (!id) return json({ error: 'missing_id' }, 400);
    if (url.searchParams.get('purge') === '1') {
      const r = await sb(`/rest/v1/projects?id=eq.${id}&${own}&deleted_at=not.is.null&select=id`);
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) return json({ error: 'not_in_trash' }, 404);
      await purgeProject(id);
      return json({ ok: true });
    }
    const r = await sb(`/rest/v1/projects?id=eq.${id}&${own}&deleted_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ deleted_at: new Date().toISOString() }),
    });
    const rows = r.ok ? await r.json() : [];
    return rows.length ? json({ ok: true, restorable_days: TRASH_DAYS }) : json({ error: 'not_found' }, 404);
  }

  return json({ error: 'method_not_allowed' }, 405);
}
