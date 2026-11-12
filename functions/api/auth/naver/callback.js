// 네이버 로그인 콜백: 네이버에서 받은 code 로 사용자 정보를 가져와 Supabase 사용자를 만들거나 찾고,
// 1회용 로그인 토큰(token_hash)을 URL 조각(#)으로 브라우저에 넘긴다. 브라우저가 supabase.auth.verifyOtp 로 세션을 만든다.
// 네이버의 이메일은 계정 연결에 쓰지 않는다 (이메일 일치로 타인 계정이 합쳐지는 것을 막기 위해 계정마다 가상 이메일을 사용).
import { sha256hex, timingSafeEqual, supabaseKey } from '../../_lib/common.js';

function safeNext(n) {
  n = String(n || '');
  if (n.charAt(0) === '/' && n.charAt(1) !== '/' && n.charAt(1) !== '\\' && !/[:\s]/.test(n)) return n;
  return '/me.html';
}

function cookie(request, name) {
  const m = (request.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const fail = code => new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/account#error=${code}`,
      'Set-Cookie': 'bold_naver=; Path=/api/auth/naver; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      'Cache-Control': 'no-store',
    },
  });
  if (request.method !== 'GET') return new Response('method_not_allowed', { status: 405 });
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) return fail('naver_not_configured');
  if (!env.SUPABASE_SERVICE_KEY) return fail('naver_not_configured');

  // 1) state(CSRF) 검증
  // 쿠키 형식: <state(16진수)>.<인코딩된 next>. state 에는 점이 없으므로 첫 번째 점에서만 나눈다
  const rawCookie = cookie(request, 'bold_naver');
  const dot = rawCookie.indexOf('.');
  const cookieState = dot > 0 ? rawCookie.slice(0, dot) : '';
  const nextEnc = dot > 0 ? rawCookie.slice(dot + 1) : '';
  const state = url.searchParams.get('state') || '';
  if (!cookieState || !timingSafeEqual(cookieState, state)) return fail('naver_state');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('naver_denied');
  let next = '/me.html';
  try { next = safeNext(decodeURIComponent(nextEnc || '')); } catch (_) {}

  // 2) code → access token → 프로필
  let profile;
  try {
    const tUrl = new URL('https://nid.naver.com/oauth2.0/token');
    tUrl.searchParams.set('grant_type', 'authorization_code');
    tUrl.searchParams.set('client_id', env.NAVER_CLIENT_ID);
    tUrl.searchParams.set('client_secret', env.NAVER_CLIENT_SECRET);
    tUrl.searchParams.set('code', url.searchParams.get('code'));
    tUrl.searchParams.set('state', state);
    const tr = await fetch(tUrl.toString());
    const tok = await tr.json();
    if (!tr.ok || !tok.access_token) return fail('naver_token');
    const pr = await fetch('https://openapi.naver.com/v1/nid/me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const pj = await pr.json();
    if (!pr.ok || pj.resultcode !== '00' || !pj.response || !pj.response.id) return fail('naver_profile');
    profile = pj.response;
  } catch (_) {
    return fail('naver_error');
  }

  // 3) Supabase 사용자 만들기/찾기 (service_role). 가상 이메일 = naver_<id 해시>@naver.invalid
  const key = supabaseKey(env);
  const sbH = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const email = `naver_${(await sha256hex('naver:' + profile.id)).slice(0, 32)}@naver.invalid`;
  const nickname = String(profile.nickname || '').slice(0, 30);
  const avatar = /^https:\/\//.test(profile.profile_image || '') ? profile.profile_image : null;

  const cr = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: sbH,
    body: JSON.stringify({
      email, email_confirm: true,
      app_metadata: { provider: 'naver', providers: ['naver'] },
      user_metadata: { nickname, name: nickname, avatar_url: avatar, naver_login: true },
    }),
  });
  if (!cr.ok) {
    const err = await cr.json().catch(() => ({}));
    // 이미 가입된 네이버 사용자면 정상 (email_exists), 그 외는 실패
    if (!(cr.status === 422 && (err.error_code === 'email_exists' || /already/i.test(err.msg || '')))) return fail('naver_user');
  }

  // 4) 1회용 로그인 토큰 발급
  const lr = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: sbH, body: JSON.stringify({ type: 'magiclink', email }),
  });
  const link = await lr.json().catch(() => ({}));
  const th = link.hashed_token || (link.properties && link.properties.hashed_token);
  if (!lr.ok || !th) return fail('naver_link');

  // 토큰은 서버 로그·Referer 에 남지 않도록 URL 조각(#)으로 전달
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/account?next=${encodeURIComponent(next)}#naver_th=${encodeURIComponent(th)}`,
      'Set-Cookie': 'bold_naver=; Path=/api/auth/naver; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
