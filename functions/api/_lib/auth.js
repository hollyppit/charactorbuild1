// 회원 인증 공통: Authorization: Bearer <Supabase JWT> 를 Supabase Auth 로 검증해 사용자 정보를 돌려준다.
// 모든 회원 전용 API(프로필·그룹·프로젝트 등)가 공통으로 사용한다.

export async function getUser(request, env) {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const apikey = env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_KEY;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey, Authorization: `Bearer ${m[1]}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}
