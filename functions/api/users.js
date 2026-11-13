// 닉네임으로 사람 찾기
//  GET /api/users?q=글자   닉네임에 글자가 들어간 사람 최대 20명 (닉네임·사진만, 차단 관계·나 자신 제외)
//  닉네임과 사진은 비공개 프로필에서도 보이는 정보라 검색 결과에 함께 보여 준다.
import { corsHeaders, jsonResponder, checkOrigin, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, blockedIds, notInList } from './_lib/social.js';

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors);
  if (bad) return bad;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: '로그인하면 친구를 찾을 수 있어요.', code: 'login_required' }, 401);

  // 닉네임에 쓸 수 있는 글자만 남김 (와일드카드·특수문자 제거)
  const q = String(new URL(request.url).searchParams.get('q') || '').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎ_]/g, '').slice(0, 20);
  if (!q) return json({ users: [] });
  const me = who.user.id;
  const blocked = await blockedIds(env, me);
  const pattern = encodeURIComponent('*' + q.replace(/_/g, '\\_') + '*');
  const r = await makeSb(env)(`/rest/v1/profiles?nickname=ilike.${pattern}&id=neq.${me}${notInList('id', blocked)}&select=nickname,avatar_url&order=nickname.asc&limit=20`);
  const rows = r.ok ? await r.json() : [];
  // 정확히 같은 닉네임 → 앞글자가 같은 닉네임 → 나머지 순
  const low = q.toLowerCase();
  const rank = n => { const x = n.toLowerCase(); return x === low ? 0 : x.startsWith(low) ? 1 : 2; };
  rows.sort((a, b) => rank(a.nickname) - rank(b.nickname) || a.nickname.localeCompare(b.nickname, 'ko'));
  return json({ users: rows.map(u => ({ nickname: u.nickname, avatar_url: u.avatar_url || null })) });
}
