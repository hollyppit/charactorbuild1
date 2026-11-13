// 내 프로필 조회·수정·계정 삭제. 인증은 JWT(Authorization: Bearer)로 서버가 검증한다.
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb, supabaseKey } from './_lib/common.js';
import { getUser } from './_lib/auth.js';
import { removeObjects, POST_BUCKET } from './_lib/storage.js';
import { purgeGroupStories } from './_lib/housekeeping.js';

const NICK_RE = /^[0-9A-Za-z가-힣_]{2,20}$/;
const VISIBILITY = ['public', 'followers', 'private'];

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,PATCH,DELETE,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 64 * 1024, cors);
  if (bad) return bad;

  const user = await getUser(request, env);
  if (!user) return json({ error: 'login_required' }, 401);
  const sb = makeSb(env);
  const q = `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`;

  if (request.method === 'GET') {
    const r = await sb(`${q}&select=*`);
    if (r.status === 404 || r.status === 400) return json({ error: 'profiles_not_ready' }, 503);
    const rows = await r.json();
    if (!Array.isArray(rows)) return json({ error: 'profiles_not_ready' }, 503);
    if (!rows.length) return json({ error: 'profile_not_found' }, 404);
    // 제재 안내 (0009 적용 전에는 빈 목록). 지난 90일 경고와 지금 효력 있는 제한
    let sanctions = [];
    try {
      const since = new Date(Date.now() - 90 * 86400000).toISOString();
      const sr = await sb(`/rest/v1/sanctions?user_id=eq.${encodeURIComponent(user.id)}&revoked_at=is.null&or=(and(kind.neq.warning,or(ends_at.is.null,ends_at.gt.${new Date().toISOString()})),created_at.gt.${since})&select=kind,reason,starts_at,ends_at,created_at&order=created_at.desc&limit=10`);
      if (sr.ok) sanctions = await sr.json();
    } catch (_) {}
    return json({ ...rows[0], email: user.email || null, provider: user.app_metadata?.provider || null, sanctions });
  }

  if (request.method === 'PATCH') {
    let b;
    try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const patch = {};
    if ('nickname' in b) {
      const n = String(b.nickname || '').trim();
      if (!NICK_RE.test(n)) return json({ error: 'invalid_nickname' }, 400);
      patch.nickname = n;
    }
    if ('bio' in b) {
      const bio = b.bio == null ? null : String(b.bio).trim();
      if (bio && bio.length > 300) return json({ error: 'bio_too_long' }, 400);
      patch.bio = bio || null;
    }
    if ('interests' in b) {
      if (!Array.isArray(b.interests) || b.interests.length > 10) return json({ error: 'invalid_interests' }, 400);
      const tags = [...new Set(b.interests.map(t => String(t).trim()).filter(Boolean))];
      if (tags.some(t => t.length > 20)) return json({ error: 'invalid_interests' }, 400);
      patch.interests = tags;
    }
    if ('visibility' in b) {
      if (!VISIBILITY.includes(b.visibility)) return json({ error: 'invalid_visibility' }, 400);
      patch.visibility = b.visibility;
    }
    if ('avatar_url' in b) {
      const a = b.avatar_url;
      // 본인 폴더의 avatars 버킷 파일만 허용 (외부 URL·타인 파일 차단)
      const prefix = `${env.SUPABASE_URL}/storage/v1/object/public/avatars/${user.id}/`;
      if (a !== null && !(typeof a === 'string' && a.startsWith(prefix) && a.length < 400)) {
        return json({ error: 'invalid_avatar' }, 400);
      }
      patch.avatar_url = a;
    }
    if (!Object.keys(patch).length) return json({ error: 'nothing_to_update' }, 400);
    patch.updated_at = new Date().toISOString();

    const r = await sb(q, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (r.status === 409) return json({ error: 'nickname_taken' }, 409);
    const rows = await r.json();
    if (!r.ok) return json({ error: rows?.code === '23505' ? 'nickname_taken' : 'update_failed' }, rows?.code === '23505' ? 409 : 500);
    return json(rows[0] || {});
  }

  if (request.method === 'DELETE') {
    let b;
    try { b = await request.json(); } catch { b = {}; }
    if (b.confirm !== 'DELETE') return json({ error: 'confirm_required' }, 400);
    const key = supabaseKey(env);
    if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
    // 프로필 이미지 파일 정리 (실패해도 계속)
    try {
      const l = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/avatars`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: user.id, limit: 100 }),
      });
      const files = l.ok ? await l.json() : [];
      if (Array.isArray(files) && files.length) {
        await fetch(`${env.SUPABASE_URL}/storage/v1/object/avatars`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: files.map(f => `${user.id}/${f.name}`) }),
        });
      }
    } catch (_) {}
    // 게시물 그림·작업 파일 정리 (DB 행은 계정 삭제 때 CASCADE 로 함께 지워짐. 실패해도 계속)
    try {
      const sbx = makeSb(env);
      const [pm, pa] = await Promise.all([
        sbx(`/rest/v1/post_media?owner_id=eq.${encodeURIComponent(user.id)}&select=path,audio_path`),
        sbx(`/rest/v1/project_assets?owner_id=eq.${encodeURIComponent(user.id)}&select=path`),
      ]);
      const postPaths = pm.ok ? (await pm.json()).flatMap(x => x.audio_path ? [x.path, x.audio_path] : [x.path]) : [];
      const assetPaths = pa.ok ? (await pa.json()).map(x => x.path) : [];
      for (let i = 0; i < postPaths.length; i += 100) await removeObjects(env, postPaths.slice(i, i + 100), POST_BUCKET);
      for (let i = 0; i < assetPaths.length; i += 100) await removeObjects(env, assetPaths.slice(i, i + 100));
    } catch (_) {}
    // 그룹: 모둠장인 그룹은 함께 지워지므로 그 그룹 작품의 파일(다른 그룹원 것 포함)과 용량을 먼저 정리하고,
    // 다른 그룹에 내가 올린 그림 파일도 지운다 (DB 행은 계정 삭제 때 CASCADE)
    try {
      const sbx = makeSb(env);
      const gr = await sbx(`/rest/v1/groups?owner_id=eq.${encodeURIComponent(user.id)}&select=id`);
      const gids = gr.ok ? (await gr.json()).map(x => x.id) : [];
      if (gids.length) {
        const sr = await sbx(`/rest/v1/group_stories?group_id=in.(${gids.join(',')})&select=id`);
        await purgeGroupStories(env, sr.ok ? (await sr.json()).map(x => x.id) : []);
      }
      const ga = await sbx(`/rest/v1/group_story_assets?uploader_id=eq.${encodeURIComponent(user.id)}&select=path`);
      const gPaths = ga.ok ? (await ga.json()).map(x => x.path) : [];
      for (let i = 0; i < gPaths.length; i += 100) await removeObjects(env, gPaths.slice(i, i + 100));
    } catch (_) {}
    // 계정 삭제 (profiles 는 ON DELETE CASCADE)
    const d = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!d.ok) return json({ error: 'delete_failed' }, 500);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
