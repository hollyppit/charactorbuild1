// 기존 비회원 저장(draw_saves)을 내 계정으로 이전. 로그인 + 저장 이름·비밀번호(해시) 일치가 모두 필요하다.
//  POST ?action=lookup  {user_name, password_hash}            → 일치하는 저장 목록 (일치가 없으면 403, 시도 횟수 제한)
//  POST ?action=start   {save_id, user_name, password_hash}   → 이전 시작(잠금) + 레이어 정보
//  POST ?action=finish  {claim_id, project_id}                → 이전 완료 표시
//  POST ?action=delete-original {claim_id}                    → 이전이 끝난 원본 삭제 (선택)
// 파일 복사는 브라우저가 기존 업로드 경로(/api/assets)로 수행한다 (서버 요청당 외부 호출 제한 회피).
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb, supabaseKey, timingSafeEqual } from './_lib/common.js';
import { getUser } from './_lib/auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const OWNER_FAIL_LIMIT = 5;          // 계정당 15분에 틀린 시도 5회
const OWNER_WINDOW_MS = 15 * 60 * 1000;
const NAME_FAIL_LIMIT = 20;          // 같은 저장 이름에 대한 틀린 시도 (전체 계정 합계) 1시간 20회
const NAME_WINDOW_MS = 60 * 60 * 1000;
const STALE_CLAIM_MS = 60 * 60 * 1000; // 시작만 하고 끝내지 않은 이전은 1시간 뒤 풀림

function storagePath(url) {
  const m = String(url || '').match(/\/object\/public\/draw-saves\/([^?]+)/);
  return m ? m[1] : null;
}

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
  const uid = encodeURIComponent(user.id);

  const notReady = r => (r.status === 404 || r.status === 400) ? json({ error: 'legacy_not_ready' }, 503) : null;

  // 시도 횟수 제한 확인. 초과면 429 Response, 아니면 null
  async function rateLimited(nameKey) {
    const since1 = encodeURIComponent(new Date(Date.now() - OWNER_WINDOW_MS).toISOString());
    const since2 = encodeURIComponent(new Date(Date.now() - NAME_WINDOW_MS).toISOString());
    const [a, c] = await Promise.all([
      sb(`/rest/v1/claim_attempts?owner_id=eq.${uid}&ok=eq.false&attempted_at=gte.${since1}&select=id`),
      sb(`/rest/v1/claim_attempts?key=eq.${encodeURIComponent(nameKey)}&ok=eq.false&attempted_at=gte.${since2}&select=id`),
    ]);
    if (a.status === 404 || c.status === 404) return json({ error: 'legacy_not_ready' }, 503);
    const ownerFails = a.ok ? (await a.json()).length : 0;
    const nameFails = c.ok ? (await c.json()).length : 0;
    if (ownerFails >= OWNER_FAIL_LIMIT || nameFails >= NAME_FAIL_LIMIT) return json({ error: 'too_many_attempts', retry_minutes: 15 }, 429);
    return null;
  }
  const logAttempt = (nameKey, ok) => sb('/rest/v1/claim_attempts', {
    method: 'POST', body: JSON.stringify({ owner_id: user.id, key: nameKey, ok }),
  });

  // 저장 이름·비밀번호 해시 검증. 성공 시 draw_saves 행 배열, 실패 시 null
  async function verify({ user_name, password_hash, save_id }) {
    const name = String(user_name || '').trim();
    if (!name || name.length > 60 || !SHA.test(String(password_hash || ''))) return { error: json({ error: 'invalid_input' }, 400) };
    const key = name.toLowerCase();
    const limited = await rateLimited(key);
    if (limited) return { error: limited };
    let q = `/rest/v1/draw_saves?user_name=eq.${encodeURIComponent(name)}&select=id,user_name,password_hash,thumbnail_url,layer_count,layers_meta,canvas_w,canvas_h,created_at,claimed_by`;
    if (save_id) q += `&id=eq.${save_id}`;
    const r = await sb(q);
    const nr = notReady(r); if (nr) return { error: nr };
    const rows = (r.ok ? await r.json() : []).filter(x => timingSafeEqual(x.password_hash, password_hash));
    if (!rows.length) { await logAttempt(key, false); return { error: json({ error: 'no_match' }, 403) }; }
    return { rows, key };
  }

  // ── 일치하는 저장 찾기 ──
  if (action === 'lookup') {
    const v = await verify(b);
    if (v.error) return v.error;
    const ids = v.rows.map(x => x.id);
    const cl = await sb(`/rest/v1/legacy_claims?source_id=in.(${ids.join(',')})&select=source_id,owner_id,status,started_at`);
    const claims = cl.ok ? await cl.json() : [];
    const items = v.rows.map(x => {
      const c = claims.find(k => k.source_id === x.id);
      let state = 'available';
      if (x.claimed_by === user.id || (c && c.owner_id === user.id && c.status === 'done')) state = 'claimed_by_me';
      else if (x.claimed_by || (c && c.status === 'done')) state = 'claimed_by_other';
      else if (c && c.status === 'started' && c.owner_id !== user.id && Date.now() - new Date(c.started_at).getTime() < STALE_CLAIM_MS) state = 'in_progress';
      return { id: x.id, user_name: x.user_name, thumbnail_url: x.thumbnail_url, layer_count: x.layer_count, created_at: x.created_at, state };
    });
    return json({ items });
  }

  // ── 이전 시작 ──
  if (action === 'start') {
    if (!UUID.test(String(b.save_id || ''))) return json({ error: 'invalid_input' }, 400);
    const v = await verify(b);
    if (v.error) return v.error;
    const save = v.rows[0];
    if (save.claimed_by && save.claimed_by !== user.id) return json({ error: 'already_claimed' }, 409);
    const cr = await sb(`/rest/v1/legacy_claims?source=eq.draw_saves&source_id=eq.${save.id}&select=id,owner_id,status,started_at`);
    const existing = cr.ok ? (await cr.json())[0] : null;
    if (existing) {
      if (existing.status === 'done') return json({ error: existing.owner_id === user.id ? 'already_claimed_by_you' : 'already_claimed' }, 409);
      const fresh = Date.now() - new Date(existing.started_at).getTime() < STALE_CLAIM_MS;
      if (existing.owner_id !== user.id && fresh) return json({ error: 'claim_in_progress' }, 409);
      // 같은 사용자의 재시도이거나 오래된 미완료 → 새로 시작
      await sb(`/rest/v1/legacy_claims?id=eq.${existing.id}`, {
        method: 'PATCH', body: JSON.stringify({ owner_id: user.id, status: 'started', started_at: new Date().toISOString() }),
      });
      return json({ claim_id: existing.id, save: pub(save) });
    }
    const ins = await sb('/rest/v1/legacy_claims', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ owner_id: user.id, source: 'draw_saves', source_id: save.id, status: 'started' }),
    });
    const rows = await ins.json().catch(() => null);
    if (!ins.ok) {
      // 동시에 다른 계정이 먼저 시작한 경우 (unique 충돌)
      return json({ error: 'claim_in_progress' }, 409);
    }
    return json({ claim_id: rows[0].id, save: pub(save) });
  }

  // ── 이전 완료 ──
  if (action === 'finish') {
    if (!UUID.test(String(b.claim_id || '')) || !UUID.test(String(b.project_id || ''))) return json({ error: 'invalid_input' }, 400);
    const cr = await sb(`/rest/v1/legacy_claims?id=eq.${b.claim_id}&owner_id=eq.${uid}&select=id,source_id,status`);
    const claim = cr.ok ? (await cr.json())[0] : null;
    if (!claim) return json({ error: 'not_found' }, 404);
    // 이전된 작업이 실제로 본인 것이고, 파일이 올라가 있어야 함
    const pr = await sb(`/rest/v1/project_assets?project_id=eq.${b.project_id}&owner_id=eq.${uid}&status=eq.ready&select=id&limit=1`);
    if (!pr.ok || !(await pr.json()).length) return json({ error: 'project_not_ready' }, 400);
    const now = new Date().toISOString();
    await sb(`/rest/v1/legacy_claims?id=eq.${claim.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', project_id: b.project_id, done_at: now }) });
    await sb(`/rest/v1/draw_saves?id=eq.${claim.source_id}`, { method: 'PATCH', body: JSON.stringify({ claimed_by: user.id, claimed_at: now }) });
    return json({ ok: true });
  }

  // ── 이전이 끝난 원본 삭제 (사용자 선택) ──
  if (action === 'delete-original') {
    if (!UUID.test(String(b.claim_id || ''))) return json({ error: 'invalid_input' }, 400);
    const cr = await sb(`/rest/v1/legacy_claims?id=eq.${b.claim_id}&owner_id=eq.${uid}&status=eq.done&select=id,source_id`);
    const claim = cr.ok ? (await cr.json())[0] : null;
    if (!claim) return json({ error: 'not_found' }, 404);
    const sr = await sb(`/rest/v1/draw_saves?id=eq.${claim.source_id}&claimed_by=eq.${uid}&select=id,layers_meta`);
    const save = sr.ok ? (await sr.json())[0] : null;
    if (!save) return json({ ok: true }); // 이미 없음
    const paths = [`${save.id}/thumb.jpg`];
    (Array.isArray(save.layers_meta) ? save.layers_meta : []).forEach((l, i) => {
      paths.push(`${save.id}/layer_${i}.${l.kind === 'draw' ? 'png' : 'jpg'}`);
      const p = storagePath(l.url); if (p) paths.push(p);
    });
    const key = supabaseKey(env);
    await fetch(`${env.SUPABASE_URL}/storage/v1/object/draw-saves`, {
      method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    });
    await sb(`/rest/v1/draw_saves?id=eq.${save.id}&claimed_by=eq.${uid}`, { method: 'DELETE' });
    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
}

// 클라이언트에 내려줄 저장 정보 (비밀번호 해시 제외)
function pub(s) {
  return { id: s.id, user_name: s.user_name, thumbnail_url: s.thumbnail_url, layers_meta: s.layers_meta, canvas_w: s.canvas_w, canvas_h: s.canvas_h };
}
