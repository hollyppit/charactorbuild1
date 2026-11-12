// 네이버 로그인 시작: CSRF 방지용 state 를 쿠키에 저장하고 네이버 인증 화면으로 이동시킨다.
// NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없으면 로그인 화면으로 오류와 함께 되돌린다.

function safeNext(n) {
  n = String(n || '');
  if (n.charAt(0) === '/' && n.charAt(1) !== '/' && n.charAt(1) !== '\\' && !/[:\s]/.test(n)) return n;
  return '/me.html';
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return new Response('method_not_allowed', { status: 405 });
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) {
    return Response.redirect(`${url.origin}/account#error=naver_not_configured`, 302);
  }
  const next = safeNext(url.searchParams.get('next'));
  const stateBytes = crypto.getRandomValues(new Uint8Array(24));
  const state = [...stateBytes].map(b => b.toString(16).padStart(2, '0')).join('');

  const auth = new URL('https://nid.naver.com/oauth2.0/authorize');
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', env.NAVER_CLIENT_ID);
  auth.searchParams.set('redirect_uri', `${url.origin}/api/auth/naver/callback`);
  auth.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: auth.toString(),
      'Set-Cookie': `bold_naver=${state}.${encodeURIComponent(next)}; Path=/api/auth/naver; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
  });
}
