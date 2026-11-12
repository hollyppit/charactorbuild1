// 보호자 계정 아래 아동 프로필 관리. 기능 플래그 CHILD_PROFILES_ENABLED=true 일 때만 동작한다.
// 아동은 계정이 없고, 보호자(JWT 로그인)만 호출한다. 쓰기는 모두 서버에서 검증한다.
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb, sha256hex, timingSafeEqual } from './_lib/common.js';
import { getUser } from './_lib/auth.js';

const CONSENT_VERSION = 'v1-draft'; // 개인정보 처리방침·동의문 확정 시 갱신
const CONSENT_KEYS = ['collect', 'ai_processing', 'retention', 'guardian_rights'];
const AVATARS = ['fox', 'cat', 'bear', 'rabbit', 'robot', 'star', 'dino', 'panda'];
const AGE_GROUPS = ['7-9', '10-13'];
const NICK_RE = /^[0-9A-Za-z가-힣_]{2,12}$/;
const PIN_RE = /^\d{4}$/;
const MAX_CHILDREN = 5;
const RESTORE_DAYS = 30;
const PUBLIC_COLS = 'id,nickname,avatar_key,age_group,created_at,deleted_at';

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
async function pbkdf2(pin, saltBytes) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 100000 }, key, 256);
}
async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${b64(salt)}:${b64(await pbkdf2(pin, salt))}`;
}
async function checkPin(pin, stored) {
  const [s, h] = String(stored || '').split(':');
  if (!s || !h) return false;
  const salt = Uint8Array.from(atob(s), c => c.charCodeAt(0));
  return timingSafeEqual(b64(await pbkdf2(pin, salt)), h);
}

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,PATCH,DELETE,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (env.CHILD_PROFILES_ENABLED !== 'true') return json({ error: 'feature_disabled' }, 404);
  const bad = checkOrigin(request, env, cors) || checkSize(request, 32 * 1024, cors);
  if (bad) return bad;

  const user = await getUser(request, env);
  if (!user) return json({ error: 'login_required' }, 401);
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const sb = makeSb(env);
  const action = new URL(request.url).searchParams.get('action') || '';

  let body = {};
  if (request.method !== 'GET') {
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  }

  // 보호자 프로필(선언 여부) 조회
  const pr = await sb(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,guardian_declared_at`);
  const prRows = pr.ok ? await pr.json() : null;
  if (!Array.isArray(prRows) || !prRows.length) return json({ error: 'profiles_not_ready' }, 503);
  const declared = !!prRows[0].guardian_declared_at;

  const childQ = id => `/rest/v1/child_profiles?id=eq.${encodeURIComponent(id)}&guardian_id=eq.${encodeURIComponent(user.id)}`;

  // 목록
  if (request.method === 'GET') {
    const r = await sb(`/rest/v1/child_profiles?guardian_id=eq.${encodeURIComponent(user.id)}&select=${PUBLIC_COLS}&order=created_at.asc`);
    const rows = r.ok ? await r.json() : [];
    const cutoff = Date.now() - RESTORE_DAYS * 86400000;
    return json({
      guardian_declared: declared, max: MAX_CHILDREN, consent_version: CONSENT_VERSION,
      children: rows.filter(c => !c.deleted_at),
      restorable: rows.filter(c => c.deleted_at && new Date(c.deleted_at).getTime() > cutoff),
    });
  }

  // 보호자 본인 선언 (만 19세 이상 + 법정대리인)
  if (request.method === 'POST' && action === 'declare') {
    if (body.adult !== true) return json({ error: 'declaration_required' }, 400);
    const r = await sb(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: 'PATCH', body: JSON.stringify({ guardian_declared_at: new Date().toISOString() }),
    });
    return r.ok ? json({ ok: true }) : json({ error: 'declare_failed' }, 500);
  }

  // PIN 확인 (아이 모드 이탈용 편의 장치)
  if (request.method === 'POST' && action === 'verify-pin') {
    if (!PIN_RE.test(String(body.pin || ''))) return json({ error: 'invalid_pin' }, 400);
    const r = await sb(`${childQ(body.id)}&deleted_at=is.null&select=pin_hash`);
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return json({ error: 'not_found' }, 404);
    return (await checkPin(String(body.pin), rows[0].pin_hash)) ? json({ ok: true }) : json({ ok: false }, 403);
  }

  // 삭제 취소 (30일 이내)
  if (request.method === 'POST' && action === 'restore') {
    const r = await sb(`${childQ(body.id)}&select=deleted_at`);
    const rows = r.ok ? await r.json() : [];
    if (!rows.length || !rows[0].deleted_at) return json({ error: 'not_found' }, 404);
    if (Date.now() - new Date(rows[0].deleted_at).getTime() > RESTORE_DAYS * 86400000) return json({ error: 'restore_expired' }, 410);
    const cnt = await sb(`/rest/v1/child_profiles?guardian_id=eq.${encodeURIComponent(user.id)}&deleted_at=is.null&select=id`);
    if (((cnt.ok ? await cnt.json() : []).length) >= MAX_CHILDREN) return json({ error: 'child_limit' }, 409);
    const u = await sb(childQ(body.id), { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ deleted_at: null }) });
    if (!u.ok) return json({ error: 'restore_failed' }, 409);
    return json({ ok: true });
  }

  // 생성
  if (request.method === 'POST') {
    if (!declared) return json({ error: 'guardian_declaration_required' }, 403);
    const nickname = String(body.nickname || '').trim();
    if (!NICK_RE.test(nickname)) return json({ error: 'invalid_nickname' }, 400);
    if (!AVATARS.includes(body.avatar_key)) return json({ error: 'invalid_avatar' }, 400);
    if (!AGE_GROUPS.includes(body.age_group)) return json({ error: 'invalid_age_group' }, 400);
    if (!PIN_RE.test(String(body.pin || ''))) return json({ error: 'invalid_pin' }, 400);
    const items = body.consent && body.consent.items;
    if (!items || !CONSENT_KEYS.every(k => items[k] === true) || body.consent.version !== CONSENT_VERSION) {
      return json({ error: 'consent_required' }, 400);
    }
    const cnt = await sb(`/rest/v1/child_profiles?guardian_id=eq.${encodeURIComponent(user.id)}&deleted_at=is.null&select=id`);
    const active = cnt.ok ? await cnt.json() : [];
    if (active.length >= MAX_CHILDREN) return json({ error: 'child_limit' }, 409);

    const c = await sb('/rest/v1/child_profiles', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ guardian_id: user.id, nickname, avatar_key: body.avatar_key, age_group: body.age_group, pin_hash: await hashPin(String(body.pin)) }),
    });
    const created = await c.json().catch(() => null);
    if (!c.ok) {
      const code = created && created.code;
      return json({ error: code === '23505' ? 'nickname_taken' : 'create_failed' }, code === '23505' ? 409 : 500);
    }
    const child = created[0];
    const ip = request.headers.get('CF-Connecting-IP') || '';
    await sb('/rest/v1/guardian_consents', {
      method: 'POST',
      body: JSON.stringify({
        guardian_id: user.id, child_id: child.id, consent_version: CONSENT_VERSION,
        items: Object.fromEntries(CONSENT_KEYS.map(k => [k, true])),
        ip_hash: ip ? await sha256hex(ip + ':' + user.id) : null,
      }),
    });
    const { pin_hash, ...safe } = child;
    return json(safe, 201);
  }

  // 수정
  if (request.method === 'PATCH') {
    const patch = {};
    if ('nickname' in body) {
      const n = String(body.nickname || '').trim();
      if (!NICK_RE.test(n)) return json({ error: 'invalid_nickname' }, 400);
      patch.nickname = n;
    }
    if ('avatar_key' in body) {
      if (!AVATARS.includes(body.avatar_key)) return json({ error: 'invalid_avatar' }, 400);
      patch.avatar_key = body.avatar_key;
    }
    if ('age_group' in body) {
      if (!AGE_GROUPS.includes(body.age_group)) return json({ error: 'invalid_age_group' }, 400);
      patch.age_group = body.age_group;
    }
    if ('new_pin' in body) {
      if (!PIN_RE.test(String(body.new_pin))) return json({ error: 'invalid_pin' }, 400);
      patch.pin_hash = await hashPin(String(body.new_pin));
    }
    if (!Object.keys(patch).length) return json({ error: 'nothing_to_update' }, 400);
    const r = await sb(`${childQ(body.id)}&deleted_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    const rows = await r.json().catch(() => null);
    if (!r.ok) return json({ error: rows && rows.code === '23505' ? 'nickname_taken' : 'update_failed' }, rows && rows.code === '23505' ? 409 : 500);
    if (!rows.length) return json({ error: 'not_found' }, 404);
    const { pin_hash, ...safe } = rows[0];
    return json(safe);
  }

  // 삭제 (소프트 삭제 + 동의 철회 기록). 30일 안에는 복구 가능, 이후 영구 삭제 대상
  if (request.method === 'DELETE') {
    const now = new Date().toISOString();
    const r = await sb(`${childQ(body.id)}&deleted_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ deleted_at: now }) });
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return json({ error: 'not_found' }, 404);
    await sb(`/rest/v1/guardian_consents?child_id=eq.${encodeURIComponent(body.id)}&guardian_id=eq.${encodeURIComponent(user.id)}&revoked_at=is.null`, {
      method: 'PATCH', body: JSON.stringify({ revoked_at: now }),
    });
    return json({ ok: true, restorable_days: RESTORE_DAYS });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
