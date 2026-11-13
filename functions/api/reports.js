// 신고
//  POST /api/reports  {target_type:'post'|'profile', target_id, reason, detail?}
//  같은 대상은 한 사람이 한 번만. 게시물은 서로 다른 신고자가 설정한 수(기본 3명)에 이르면 자동으로 가려진다.
import { corsHeaders, jsonResponder, checkOrigin, checkSize } from './_lib/common.js';
import { whoIs, disabledReply, rpc, UUID, REASONS } from './_lib/social.js';

const ERR = {
  daily_report_limit: '오늘은 더 신고할 수 없어요. 급한 내용은 h41416922@gmail.com 으로 알려 주세요.',
  self_report: '내 게시물이나 내 프로필은 신고할 수 없어요.',
  not_found: '신고할 대상을 찾을 수 없어요.',
  invalid_target: '신고할 대상을 찾을 수 없어요.',
};

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const bad = checkOrigin(request, env, cors) || checkSize(request, 4096, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);

  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: '로그인하면 신고할 수 있어요.', code: 'login_required' }, 401);

  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!['post', 'profile'].includes(b.target_type) || !UUID.test(String(b.target_id || ''))) return json({ error: ERR.invalid_target, code: 'invalid_target' }, 400);
  if (!REASONS.includes(b.reason)) return json({ error: '신고 이유를 골라 주세요.', code: 'invalid_reason' }, 400);

  const sanc = await rpc(env, 'social_active_sanction', { p_user: who.user.id });
  if (sanc.data && sanc.data.kind === 'suspend') return json({ error: '이용 정지 중에는 신고할 수 없어요.', code: 'sanctioned' }, 403);

  const res = await rpc(env, 'social_report', {
    p_reporter: who.user.id, p_type: b.target_type, p_target: b.target_id, p_reason: b.reason,
    p_detail: String(b.detail || '').slice(0, 500),
  });
  if (res.missing) return json({ error: 'social_not_ready' }, 503);
  if (res.failed || !res.data) return json({ error: 'report_failed' }, 500);
  if (!res.data.ok) return json({ error: ERR[res.data.error] || res.data.error, code: res.data.error }, res.data.error === 'daily_report_limit' ? 429 : 400);
  return json({ ok: true, already: !!res.data.already });
}
