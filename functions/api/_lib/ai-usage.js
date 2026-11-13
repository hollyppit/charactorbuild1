// AI 사용 기록·하루 한도 (라우트 아님). 0008 마이그레이션의 ai_reserve / ai_finish 함수를 사용한다.
// AI 엔드포인트는 `export const onRequest = withAiUsage('image', handle)` 처럼 감싸기만 하면 된다.
//  - 관리자(X-Admin-Hash): 한도 없음, 기록만
//  - 로그인 회원(Bearer 토큰): AI 비밀번호 없이 사용, 1인 하루 한도
//  - 비회원: AI 비밀번호 필요(설정된 경우), 같은 인터넷 주소 하루 한도 + 비회원 전체 하루 한도
// 응답이 실패(4xx/5xx)면 점수를 돌려준다. 기록 기능이 아직 설치되지 않았으면(함수 없음) 한도 없이 통과시킨다.
import { corsHeaders, checkOrigin, checkSize, isAdmin, makeSb, getAiAccessPw, timingSafeEqual, sha256hex } from './common.js';
import { getUser } from './auth.js';

const MAX_BODY = 25 * 1024 * 1024;

const LIMIT_MSG = {
  member_daily: '오늘 쓸 수 있는 AI를 다 썼어요. 내일(한국 시간 0시) 다시 채워져요.',
  guest_ip: '오늘 비회원이 쓸 수 있는 AI를 다 썼어요. 로그인하면 더 쓸 수 있어요.',
  guest_total: '오늘 비회원이 쓸 수 있는 AI를 다 썼어요. 로그인하면 더 쓸 수 있어요.',
  guest_unknown: 'AI를 쓸 수 없어요. 잠시 뒤 다시 시도해 주세요.',
};

function kstDay() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 비회원 구분값: 인터넷 주소 + 날짜 + 서버 비밀값의 해시 (날짜가 바뀌면 값도 바뀌어 날짜를 넘어 추적할 수 없음)
export async function guestKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return null;
  const secret = env.SUPABASE_SERVICE_KEY || env.ADMIN_PW_HASH || '';
  return (await sha256hex('ai-guest|' + kstDay() + '|' + ip + '|' + secret)).slice(0, 32);
}

// PostgREST 함수가 없을 때(마이그레이션 전)
async function isMissingFunction(res) {
  if (res.status !== 404) return false;
  try { const j = await res.clone().json(); return !j || j.code === 'PGRST202' || /function/i.test(j.message || ''); } catch { return true; }
}

export function withAiUsage(feature, handler) {
  return async function onRequest(context) {
    const { request, env } = context;
    if (request.method === 'OPTIONS') return handler(context);
    const cors = { ...corsHeaders(request, env, 'POST,OPTIONS'), 'Content-Type': 'application/json' };
    const reply = (data, status) => new Response(JSON.stringify(data), { status, headers: cors });

    const bad = checkOrigin(request, env, cors) || checkSize(request, MAX_BODY, cors);
    if (bad) return bad;

    const admin = isAdmin(request, env);
    const user = admin ? null : await getUser(request, env);
    if (!admin && !user) {
      // 비회원: 기존 AI 접근 비밀번호 확인
      const pw = await getAiAccessPw(env);
      if (pw === null) return reply({ error: 'gate_unavailable' }, 503);
      if (pw && !timingSafeEqual(request.headers.get('X-AI-Pw'), pw)) return reply({ error: 'ai_password_required' }, 403);
    }

    const sb = makeSb(env);
    const endpoint = new URL(request.url).pathname.replace(/^\/api\//, '');
    let usageId = null;
    try {
      const res = await sb('/rest/v1/rpc/ai_reserve', {
        method: 'POST',
        body: JSON.stringify({
          p_owner: user ? user.id : null,
          p_guest: user || admin ? null : await guestKey(request, env),
          p_admin: admin, p_endpoint: endpoint, p_feature: feature,
        }),
      });
      if (await isMissingFunction(res)) {
        usageId = null;                                   // 기록 기능 설치 전: 한도 없이 통과
      } else if (!res.ok) {
        return reply({ error: 'AI 사용량을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.', code: 'usage_unavailable' }, 503);
      } else {
        const d = await res.json();
        if (!d || d.ok !== true) {
          const reason = (d && d.reason) || 'member_daily';
          return reply({ error: LIMIT_MSG[reason] || LIMIT_MSG.member_daily, code: 'ai_daily_limit', reason,
            used: d && d.used, limit: d && d.limit, member: !!user }, 429);
        }
        usageId = d.id;
      }
    } catch (e) {
      return reply({ error: 'AI 사용량을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.', code: 'usage_unavailable' }, 503);
    }

    const t0 = Date.now();
    let res;
    try { res = await handler(context); }
    catch (e) { res = reply({ error: String((e && e.message) || e) }, 500); }

    if (usageId != null) {
      const done = sb('/rest/v1/rpc/ai_finish', {
        method: 'POST', body: JSON.stringify({ p_id: usageId, p_ok: !!(res && res.ok), p_ms: Date.now() - t0 }),
      }).catch(() => {});
      if (typeof context.waitUntil === 'function') context.waitUntil(done); else await done;
    }
    return res;
  };
}
