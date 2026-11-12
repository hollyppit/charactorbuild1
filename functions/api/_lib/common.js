// 공통 보안 유틸 (라우트 아님 — onRequest 없음)
// - 허용 Origin 기반 CORS
// - 관리자 검증 (X-Admin-Hash 헤더 == env.ADMIN_PW_HASH)
// - Supabase 호출 (서버 전용 SERVICE 키 우선, 없으면 ANON 키로 폴백)
// - AI 접근 비밀번호(서버 검증), 요청 크기 제한

const ALLOW_HEADERS = 'Content-Type, X-Admin-Hash, X-AI-Pw, X-Save-Hash';

function originOk(origin, request, env) {
  if (!origin) return true; // 같은 출처 GET 등 Origin 헤더가 없는 요청
  let o;
  try { o = new URL(origin); } catch { return false; }
  if (o.host === new URL(request.url).host) return true;
  if (o.hostname === 'localhost' || o.hostname === '127.0.0.1') return true;
  if (o.hostname.endsWith('.tossmini.com')) return true; // 토스 미니앱
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

export function corsHeaders(request, env, methods) {
  const origin = request.headers.get('Origin');
  const h = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Vary': 'Origin',
  };
  if (origin && originOk(origin, request, env)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export function jsonResponder(cors) {
  return (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
}

// 허용되지 않은 Origin이면 403 Response, 아니면 null
export function checkOrigin(request, env, cors) {
  if (originOk(request.headers.get('Origin'), request, env)) return null;
  return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
    status: 403,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// Content-Length 기준 크기 제한. 초과 시 413 Response, 아니면 null
export function checkSize(request, maxBytes, cors) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) {
    return new Response(JSON.stringify({ error: 'payload_too_large' }), {
      status: 413,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  return null;
}

function timingSafeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function isAdmin(request, env) {
  const expected = String(env.ADMIN_PW_HASH || '').toLowerCase();
  if (!expected) return false; // 미등록 시 관리자 기능 비활성화
  const got = String(request.headers.get('X-Admin-Hash') || '').toLowerCase();
  return timingSafeEqual(got, expected);
}

export function supabaseKey(env) {
  return env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY;
}

export function makeSb(env) {
  const url = env.SUPABASE_URL;
  const key = supabaseKey(env);
  return (path, opts = {}) =>
    fetch(`${url}${path}`, {
      ...opts,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });
}

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// AI 접근 비밀번호 조회 ('' = 제한 없음). 실패 시 null
export async function getAiAccessPw(env) {
  try {
    const r = await makeSb(env)('/rest/v1/char_items?id=eq.ai_access_pw&select=label');
    if (!r.ok) return null;
    const rows = await r.json();
    return rows.length ? String(rows[0].label || '') : '';
  } catch { return null; }
}

// AI 엔드포인트 공통 가드: Origin → 크기 → 접근 비밀번호. 통과하면 null
export async function guardAi(request, env, cors, maxBytes = 25 * 1024 * 1024) {
  const bad = checkOrigin(request, env, cors) || checkSize(request, maxBytes, cors);
  if (bad) return bad;
  if (isAdmin(request, env)) return null;
  const pw = await getAiAccessPw(env);
  if (pw === null) {
    return new Response(JSON.stringify({ error: 'gate_unavailable' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  if (pw && !timingSafeEqual(request.headers.get('X-AI-Pw'), pw)) {
    return new Response(JSON.stringify({ error: 'ai_password_required' }), {
      status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  return null;
}

export { timingSafeEqual };
