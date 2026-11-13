// 브라우저용 공개 설정 (Supabase URL + anon 공개 키). 비밀키는 절대 포함하지 않는다.
import { corsHeaders, jsonResponder, checkOrigin } from './_lib/common.js';
import { socialMode } from './_lib/social.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors);
  if (bad) return bad;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: 'not_configured' }, 503);
  return json({
    supabaseUrl: env.SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    naverEnabled: !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET && env.SUPABASE_SERVICE_KEY),
    // 소셜(게시·둘러보기) 공개 스위치: 'on' | 'beta'(관리자 역할 회원만) | 'off'
    social: socialMode(env),
  });
}
