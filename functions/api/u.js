// 공개 프로필
//  GET /api/u?n=닉네임[&before=ISO]
//  보이는 범위: 전체 공개 → 누구나 / 팔로워 공개 → 수락된 팔로워·본인 / 비공개 → 본인
//  보이지 않으면 닉네임·사진·팔로우 버튼 정보만. 상대가 나를 차단했으면 없는 프로필처럼 404,
//  내가 상대를 차단했으면 blocked:true 와 닉네임·사진만(차단 해제용).
import { corsHeaders, jsonResponder, checkOrigin, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, attachCovers, publicPost, POST_COLS, followStatus } from './_lib/social.js';

const NICK_RE = /^[0-9A-Za-z가-힣_]{2,20}$/;
const PAGE = 24;

async function count(sb, q) {
  const r = await sb(q, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const m = /\/(\d+)$/.exec(r.headers.get('content-range') || '');
  if (m) return Number(m[1]);
  return r.ok ? (await r.json()).length : 0;
}

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
  const url = new URL(request.url);
  const n = String(url.searchParams.get('n') || '').trim();
  if (!NICK_RE.test(n)) return json({ error: 'not_found' }, 404);
  const sb = makeSb(env);
  const me = who.user ? who.user.id : null;

  const r = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(n)}&select=id,nickname,avatar_url,bio,interests,visibility,created_at`);
  const p = (r.ok ? await r.json() : [])[0];
  if (!p) return json({ error: 'not_found' }, 404);
  const isMe = me === p.id;

  if (me && !isMe) {
    const [b1, b2] = await Promise.all([
      sb(`/rest/v1/blocks?blocker_id=eq.${p.id}&blocked_id=eq.${me}&select=blocker_id`),
      sb(`/rest/v1/blocks?blocker_id=eq.${me}&blocked_id=eq.${p.id}&select=blocker_id`),
    ]);
    if ((b1.ok ? await b1.json() : []).length) return json({ error: 'not_found' }, 404);
    if ((b2.ok ? await b2.json() : []).length) {
      return json({ id: p.id, nickname: p.nickname, avatar_url: p.avatar_url || null, is_me: false, private: true, blocked: true, posts: [], next: null });
    }
  }

  const follow = isMe ? null : await followStatus(env, me, p.id);
  const isFollower = follow === 'accepted';
  const open = isMe || p.visibility === 'public' || (p.visibility === 'followers' && isFollower);
  const [followers, following] = await Promise.all([
    count(sb, `/rest/v1/follows?followee_id=eq.${p.id}&status=eq.accepted&select=follower_id`),
    count(sb, `/rest/v1/follows?follower_id=eq.${p.id}&status=eq.accepted&select=followee_id`),
  ]);
  const base = {
    id: p.id, nickname: p.nickname, avatar_url: p.avatar_url || null, is_me: isMe, private: !open, visibility: p.visibility,
    follow_status: follow, followers_count: followers, following_count: following,
    follow_needs_approval: p.visibility !== 'public',
  };
  if (!open) return json({ ...base, posts: [], next: null });

  const before = url.searchParams.get('before');
  const vis = isMe || isFollower ? 'in.(public,followers)' : 'eq.public';
  let q = `/rest/v1/posts?owner_id=eq.${p.id}&status=eq.published&visibility=${vis}&select=${POST_COLS}&order=published_at.desc&limit=${PAGE}`;
  if (before && !isNaN(Date.parse(before))) q += `&published_at=lt.${encodeURIComponent(new Date(before).toISOString())}`;
  const pr = await sb(q);
  const rows = pr.ok ? await pr.json() : [];
  const posts = (await attachCovers(env, rows)).map(x => ({ ...publicPost(x), cover: x.cover }));
  return json({
    ...base, bio: p.bio || '', interests: p.interests || [], joined_at: p.created_at,
    posts, next: rows.length === PAGE ? rows[rows.length - 1].published_at : null,
  });
}
