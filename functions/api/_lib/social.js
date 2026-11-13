// 3단계 소셜 공통 (라우트 아님)
// 공개 스위치 SOCIAL_ENABLED: 'on' = 모두 / 'beta' = profiles.role='admin' 회원만 / 그 외(미설정) = 꺼짐.
// 관리자(X-Admin-Hash)는 스위치와 관계없이 관리 기능을 쓸 수 있다.
import { makeSb, isAdmin } from './common.js';
import { getUser } from './auth.js';
import { signDownloads, POST_BUCKET } from './storage.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KINDS = ['draw', 'character', 'storyboard', 'story', 'dub'];
export const REASONS = ['inappropriate', 'bullying', 'privacy', 'copyright', 'spam', 'other'];
export const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function socialMode(env) {
  const v = String(env.SOCIAL_ENABLED || '').trim().toLowerCase();
  return v === 'on' ? 'on' : v === 'beta' ? 'beta' : 'off';
}

// 요청자 정보: { admin, user, profile, allowed, mode }
//  allowed = 이 요청자가 지금 소셜 기능(읽기·쓰기)을 쓸 수 있는지
export async function whoIs(request, env) {
  const mode = socialMode(env);
  const admin = isAdmin(request, env);
  const user = await getUser(request, env);
  let profile = null;
  if (user) {
    const r = await makeSb(env)(`/rest/v1/profiles?id=eq.${user.id}&select=id,nickname,avatar_url,role,visibility`);
    const rows = r.ok ? await r.json() : [];
    profile = rows[0] || null;
  }
  const allowed = admin || mode === 'on' || (mode === 'beta' && !!profile && profile.role === 'admin');
  return { admin, user, profile, allowed, mode };
}

export const disabledReply = (json, mode) =>
  json({ error: mode === 'beta' ? '지금은 일부 회원만 쓸 수 있는 준비 중 기능이에요.' : '아직 준비 중인 기능이에요.', code: 'social_disabled' }, 404);

export async function rpc(env, fn, args) {
  const r = await makeSb(env)('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });
  if (r.status === 404) return { missing: true };
  const data = await r.json().catch(() => null);
  if (!r.ok) return { failed: true, status: r.status, data };
  return { data };
}

// 게시물 목록에 표지(첫 그림) 서명 주소 붙이기
export async function attachCovers(env, posts) {
  if (!posts.length) return posts;
  const ids = posts.map(p => p.id).join(',');
  const r = await makeSb(env)(`/rest/v1/post_media?post_id=in.(${ids})&idx=eq.0&status=eq.ready&select=post_id,path,width,height`);
  const rows = r.ok ? await r.json() : [];
  const urls = await signDownloads(env, rows.map(x => x.path), 3600, POST_BUCKET);
  const byPost = Object.fromEntries(rows.map(x => [x.post_id, { url: urls[x.path] || null, width: x.width, height: x.height }]));
  return posts.map(p => ({ ...p, cover: byPost[p.id] || null }));
}

// 한 게시물의 그림 전체(순서대로) + 서명 주소
export async function mediaOf(env, postId) {
  const r = await makeSb(env)(`/rest/v1/post_media?post_id=eq.${postId}&status=eq.ready&select=idx,path,mime,width,height,body&order=idx.asc`);
  const rows = r.ok ? await r.json() : [];
  const urls = await signDownloads(env, rows.map(x => x.path), 3600, POST_BUCKET);
  return rows.map(x => ({ idx: x.idx, url: urls[x.path] || null, width: x.width, height: x.height, body: x.body || '' }));
}

// 게시물을 밖으로 내보낼 때의 모양 (owner 는 profiles 임베드 결과)
export function publicPost(p) {
  const o = p.owner || {};
  return {
    id: p.id, kind: p.kind, title: p.title, caption: p.caption || '', media_count: p.media_count,
    published_at: p.published_at, created_at: p.created_at, visibility: p.visibility,
    like_count: p.like_count || 0, comment_count: p.comment_count || 0,
    owner: { nickname: o.nickname || '', avatar_url: o.avatar_url || null },
  };
}

// 0010(3-B) 이후 컬럼(like_count, comment_count, comments_mode) 포함 — 0010 을 먼저 적용한 뒤 배포할 것
export const POST_COLS = 'id,owner_id,kind,title,caption,visibility,status,status_reason,media_count,bytes,report_count,like_count,comment_count,comments_mode,source_project_id,created_at,updated_at,published_at,reviewed_at,owner:profiles!posts_owner_id_fkey(nickname,avatar_url,visibility)';

// 게시물 주인에게 보여 줄 상태 안내
export function statusText(status, reason) {
  if (status === 'pending') return '관리자가 확인한 뒤 공개돼요.';
  if (status === 'published') return '공개 중이에요.';
  if (status === 'rejected') return '공개되지 않았어요' + (reason ? ': ' + reason : '.');
  if (status === 'hidden') {
    if (reason === 'auto_hidden') return '신고가 여러 번 들어와 잠시 가려졌어요. 관리자가 확인하고 있어요.';
    if (reason === 'account_suspended') return '계정 이용 정지로 가려졌어요.';
    return '관리자가 가렸어요' + (reason ? ': ' + reason : '.');
  }
  if (status === 'uploading') return '그림을 올리는 중이에요.';
  return '';
}

// ── 3-B: 차단·팔로우 확인 ──
// 나와 차단 관계(어느 쪽이든)인 사람 id 목록
export async function blockedIds(env, userId) {
  if (!userId) return [];
  const sb = makeSb(env);
  const [a, b] = await Promise.all([
    sb(`/rest/v1/blocks?blocker_id=eq.${userId}&select=blocked_id`),
    sb(`/rest/v1/blocks?blocked_id=eq.${userId}&select=blocker_id`),
  ]);
  const ids = [...(a.ok ? await a.json() : []).map(x => x.blocked_id), ...(b.ok ? await b.json() : []).map(x => x.blocker_id)];
  return [...new Set(ids)];
}
// 내가 (수락된) 팔로우 중인 사람 id 목록
export async function followeeIds(env, userId) {
  if (!userId) return [];
  const r = await makeSb(env)(`/rest/v1/follows?follower_id=eq.${userId}&status=eq.accepted&select=followee_id&limit=5000`);
  return (r.ok ? await r.json() : []).map(x => x.followee_id);
}
// a 가 b 를 팔로우하는 상태: null | 'pending' | 'accepted'
export async function followStatus(env, a, b) {
  if (!a || !b || a === b) return null;
  const r = await makeSb(env)(`/rest/v1/follows?follower_id=eq.${a}&followee_id=eq.${b}&select=status`);
  return ((r.ok ? await r.json() : [])[0] || {}).status || null;
}
export const notInList = (col, ids) => ids.length ? `&${col}=not.in.(${ids.join(',')})` : '';

// 관리 알림 넣기 (서버 전용). 0010 적용 전에는 조용히 실패
export async function notify(env, userId, type, extra) {
  try {
    await makeSb(env)('/rest/v1/notifications', { method: 'POST', body: JSON.stringify({ user_id: userId, type, ...(extra || {}) }) });
  } catch (_) {}
}
