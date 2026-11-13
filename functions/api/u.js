// 공개 프로필
//  GET /api/u?n=닉네임[&before=ISO]
//  전체 공개 프로필: 닉네임·사진·소개·관심 분야·공개 게시물 / 그 외(비공개·팔로워 공개): 닉네임·사진만
import { corsHeaders, jsonResponder, checkOrigin, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, attachCovers, publicPost, POST_COLS } from './_lib/social.js';

const NICK_RE = /^[0-9A-Za-z가-힣_]{2,20}$/;
const PAGE = 24;

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

  const r = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(n)}&select=id,nickname,avatar_url,bio,interests,visibility,created_at`);
  const p = (r.ok ? await r.json() : [])[0];
  if (!p) return json({ error: 'not_found' }, 404);
  const isMe = !!(who.user && who.user.id === p.id);
  const open = p.visibility === 'public' || isMe;

  const base = { id: p.id, nickname: p.nickname, avatar_url: p.avatar_url || null, is_me: isMe, private: !open };
  if (!open) return json({ ...base, posts: [], next: null });

  const before = url.searchParams.get('before');
  let q = `/rest/v1/posts?owner_id=eq.${p.id}&status=eq.published&visibility=eq.public&select=${POST_COLS}&order=published_at.desc&limit=${PAGE}`;
  if (before && !isNaN(Date.parse(before))) q += `&published_at=lt.${encodeURIComponent(new Date(before).toISOString())}`;
  const pr = await sb(q);
  const rows = pr.ok ? await pr.json() : [];
  const posts = (await attachCovers(env, rows)).map(x => ({ ...publicPost(x), cover: x.cover }));
  return json({
    ...base, bio: p.bio || '', interests: p.interests || [], joined_at: p.created_at,
    posts, next: rows.length === PAGE ? rows[rows.length - 1].published_at : null,
  });
}
