// 그룹 그림책 공동 제작 (4단계-B)
//  GET  /api/group-stories?group=uuid            그룹의 작품 목록 (그룹원만)
//  GET  /api/group-stories?id=uuid               작품 자세히: 공통 설정·장면(완성본, 내 임시본)·잠금·그룹원·버전·기여 기록
//  GET  /api/group-stories?id=uuid&version=n     예전 버전 보기
//  POST /api/group-stories {action, story_id?, ...}
//    create {group_id, mode, title, common?, scenes:[{k, ord, script}]}  (모둠장)
//    update_common {title?, common:{logline, charDesc, charRef(asset id|null), style, styleText, aspect}} (모둠장)
//    import_images {images:{k: asset_id}}  (모둠장, 가져오기 직후 완성본 그림 채우기)
//    assign {k, nickname|null} / lock {k} / unlock {k} / save {k, script, image} / submit {k}
//    review {k, approve, reason?} (모둠장) / restore {n} (모둠장) / delete (모둠장)
//    asset {sha256, mime, bytes} → 업로드 토큰 / asset_confirm {asset_id}
//  (4-C 게시) GET ?request=uuid 동의 화면 / propose {title, caption, visibility, comments_mode} · cancel_publish (모둠장)
//    respond_publish {request_id, agree} (동의를 부탁받은 사람)
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { signUpload, objectInfo, removeObjects, signDownloads, BUCKET } from './_lib/storage.js';
import { whoIs, disabledReply, rpc, UUID } from './_lib/social.js';
import { hasBadWord } from './_lib/words.js';

const SHA = /^[0-9a-f]{64}$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ASPECTS = ['4:3', '3:4', '1:1'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const ERR = {
  not_owner: '모둠장만 할 수 있어요.', no_permission: '"만들기" 역할만 할 수 있어요.', not_found: '작품이나 장면을 찾을 수 없어요.',
  sanctioned: '지금은 이용 제한 중이라 할 수 없어요.', story_limit: '한 그룹의 작품은 10개까지예요.', invalid_scenes: '장면 수가 올바르지 않아요 (1~40).',
  not_editor: '"만들기" 역할인 그룹원에게만 맡길 수 있어요.', submitted_wait: '제출된 장면이에요. 모둠장이 승인하거나 다시 요청한 뒤에 할 수 있어요.',
  not_assignee: '이 장면을 맡은 사람만 고칠 수 있어요.', locked: '다른 친구가 고치는 중이에요.', lock_lost: '편집 시간이 끝났어요. "편집 시작"을 다시 눌러 주세요.',
  invalid_image: '그림 파일을 다시 올려 주세요.', nothing_to_submit: '제출할 내용이 없어요.', not_submitted: '제출된 장면이 아니에요.',
  reason_required: '다시 요청하는 이유를 적어 주세요.', quota_exceeded: '저장 공간이 부족해요. 마이페이지에서 정리해 주세요.',
  nothing_to_publish: '완성된 장면이 없어요. 장면을 승인한 뒤 제안해 주세요.', expired: '7일이 지나 이번 게시 요청이 끝났어요.',
  not_pending: '이미 끝난 게시 요청이에요.', not_ready: '아직 모두 동의하지 않았어요.',
};

// 쓰지 않는 그룹 그림 정리: 완성본·임시본·버전 기록·공통 캐릭터 그림 어디에도 없고 올린 지 하루가 지난 파일
async function gcGroupAssets(env, storyId) {
  const sb = makeSb(env);
  const [ar, sr, cr, vr] = await Promise.all([
    sb(`/rest/v1/group_story_assets?story_id=eq.${storyId}&select=id,path,bytes,uploader_id,created_at`),
    sb(`/rest/v1/group_stories?id=eq.${storyId}&select=common`),
    sb(`/rest/v1/group_story_scenes?story_id=eq.${storyId}&select=final,draft`),
    sb(`/rest/v1/group_story_versions?story_id=eq.${storyId}&select=snapshot`),
  ]);
  if (!ar.ok || !sr.ok || !cr.ok || !vr.ok) return 0;
  const used = new Set();
  const scan = o => { for (const m of JSON.stringify(o || {}).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) used.add(m[0].toLowerCase()); };
  (await sr.json()).forEach(scan); (await cr.json()).forEach(scan); (await vr.json()).forEach(scan);
  const cutoff = Date.now() - 86400000;
  const orphans = (await ar.json()).filter(a => !used.has(a.id.toLowerCase()) && Date.parse(a.created_at) < cutoff);
  if (!orphans.length) return 0;
  await removeObjects(env, orphans.map(a => a.path), BUCKET);
  await sb(`/rest/v1/group_story_assets?id=in.(${orphans.map(a => a.id).join(',')})`, { method: 'DELETE' });
  const per = {};
  orphans.forEach(a => { per[a.uploader_id] = (per[a.uploader_id] || 0) + Number(a.bytes || 0); });
  for (const [owner, bytes] of Object.entries(per)) if (bytes > 0) await rpc(env, 'release_quota', { p_owner: owner, p_bytes: bytes });
  return orphans.length;
}

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 256 * 1024, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: '로그인이 필요해요.', code: 'login_required' }, 401);
  const me = who.user.id;
  const sb = makeSb(env);
  const fail = (code, status = 400, extra) => json({ error: ERR[code] || code, code, ...(extra || {}) }, status);
  const out = (res, extra) => {
    if (res.missing) return json({ error: 'group_stories_not_ready' }, 503);
    if (!res.data) return json({ error: 'failed' }, 500);
    if (!res.data.ok) return fail(res.data.error, res.data.error === 'not_found' ? 404 : ['not_owner', 'no_permission', 'not_assignee'].includes(res.data.error) ? 403 : 400, { by: res.data.by, until: res.data.until });
    return json({ ...res.data, ...(extra || {}) });
  };
  const roleIn = async storyId => { const r = await rpc(env, 'gs_role', { p_user: me, p_story: storyId }); return r.missing ? undefined : (r.data || null); };

  // 그림 파일 id → 1시간 서명 주소
  async function urlsFor(storyId, ids) {
    ids = [...new Set(ids.filter(x => UUID.test(String(x || ''))))];
    if (!ids.length) return {};
    const r = await sb(`/rest/v1/group_story_assets?story_id=eq.${storyId}&id=in.(${ids.join(',')})&status=eq.ready&select=id,path`);
    const rows = r.ok ? await r.json() : [];
    const signed = await signDownloads(env, rows.map(x => x.path), 3600, BUCKET);
    return Object.fromEntries(rows.map(x => [x.id, signed[x.path] || null]));
  }
  const nicks = async ids => {
    ids = [...new Set(ids.filter(Boolean))];
    if (!ids.length) return {};
    const r = await sb(`/rest/v1/profiles?id=in.(${ids.join(',')})&select=id,nickname`);
    return Object.fromEntries((r.ok ? await r.json() : []).map(x => [x.id, x.nickname]));
  };

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const gid = url.searchParams.get('group'), id = url.searchParams.get('id');
    // 게시 동의 화면: 동의 목록에 있는 사람(그룹을 나갔어도) 또는 제안자만
    const rq = url.searchParams.get('request');
    if (rq) {
      if (!UUID.test(rq)) return fail('not_found', 404);
      const r = await sb(`/rest/v1/group_publish_requests?id=eq.${rq}&select=*,story:group_stories(id,title,group_id,deleted_at,group:groups(name))`);
      if (r.status === 404 || r.status === 400) return json({ error: 'group_stories_not_ready' }, 503);
      const req = (r.ok ? await r.json() : [])[0];
      if (!req || !req.story || req.story.deleted_at) return fail('not_found', 404);
      const cr2 = await sb(`/rest/v1/group_publish_consents?request_id=eq.${rq}&select=user_id,status,responded_at`);
      const consents = cr2.ok ? await cr2.json() : [];
      const mine = consents.find(c => c.user_id === me);
      if (!mine && req.proposer_id !== me) return fail('not_found', 404);
      const vr = await sb(`/rest/v1/group_story_versions?story_id=eq.${req.story_id}&n=eq.${req.version_n}&select=snapshot`);
      const sn = ((vr.ok ? await vr.json() : [])[0] || {}).snapshot || {};
      const urls = await urlsFor(req.story_id, (sn.scenes || []).map(x => x.final && x.final.image));
      const N = await nicks([req.proposer_id, ...consents.map(c => c.user_id), ...(sn.scenes || []).map(x => x.final_by)]);
      const expired = req.status === 'pending' && Date.parse(req.expires_at) < Date.now();
      return json({
        request: { id: req.id, status: expired ? 'expired' : req.status, title: req.title, caption: req.caption || '', visibility: req.visibility, expires_at: req.expires_at, post_id: req.post_id,
          proposer: N[req.proposer_id] || '', story_title: (req.story || {}).title || '', group_name: ((req.story || {}).group || {}).name || '' },
        my_consent: mine ? mine.status : null, is_proposer: req.proposer_id === me, story_id: req.story_id,
        consents: consents.map(c => ({ nickname: N[c.user_id] || '', status: c.status })),
        scenes: (sn.scenes || []).filter(x => x.final).map(x => ({ k: x.k, script: x.final.script || '', image_url: x.final.image ? urls[x.final.image] || null : null, by: N[x.final_by] || '', mine: x.final_by === me })),
      });
    }
    if (gid) {
      if (!UUID.test(gid)) return fail('not_found', 404);
      const mr = await sb(`/rest/v1/group_members?group_id=eq.${gid}&user_id=eq.${me}&select=role`);
      if (!(mr.ok ? await mr.json() : []).length) return fail('not_found', 404);
      const r = await sb(`/rest/v1/group_stories?group_id=eq.${gid}&deleted_at=is.null&select=id,title,mode,created_at,updated_at,scenes:group_story_scenes(status,assignee_id)&order=updated_at.desc`);
      if (r.status === 404 || r.status === 400) return json({ error: 'group_stories_not_ready' }, 503);
      const rows = r.ok ? await r.json() : [];
      return json({ stories: rows.map(s => {
        const st = {}; (s.scenes || []).forEach(x => { st[x.status] = (st[x.status] || 0) + 1; });
        return { id: s.id, title: s.title, mode: s.mode, updated_at: s.updated_at, scene_count: (s.scenes || []).length, counts: st,
          mine: (s.scenes || []).filter(x => x.assignee_id === me).length };
      }) });
    }
    if (!UUID.test(String(id || ''))) return fail('not_found', 404);
    const role = await roleIn(id);
    if (role === undefined) return json({ error: 'group_stories_not_ready' }, 503);
    if (!role) return fail('not_found', 404);
    const [sr, cr] = await Promise.all([
      sb(`/rest/v1/group_stories?id=eq.${id}&select=id,group_id,title,mode,common,created_at,updated_at,group:groups(name)`),
      sb(`/rest/v1/group_story_scenes?story_id=eq.${id}&select=*&order=ord.asc`),
    ]);
    const s = (sr.ok ? await sr.json() : [])[0];
    const scenes = cr.ok ? await cr.json() : [];
    if (!s) return fail('not_found', 404);

    const vn = url.searchParams.get('version');
    if (vn) {
      const vr = await sb(`/rest/v1/group_story_versions?story_id=eq.${id}&n=eq.${parseInt(vn, 10) || 0}&select=n,snapshot,note,created_at,created_by`);
      const v = (vr.ok ? await vr.json() : [])[0];
      if (!v) return fail('not_found', 404);
      const sn = v.snapshot || {};
      const urls = await urlsFor(id, [(sn.common || {}).charRef, ...(sn.scenes || []).map(x => x.final && x.final.image)]);
      return json({ n: v.n, note: v.note, created_at: v.created_at, title: sn.title,
        scenes: (sn.scenes || []).map(x => ({ k: x.k, ord: x.ord, script: (x.final || {}).script || '', image_url: x.final && x.final.image ? urls[x.final.image] || null : null })) });
    }

    if (role === 'owner' && Math.random() < 0.1) await gcGroupAssets(env, id).catch(() => null);   // 가끔: 쓰지 않는 그림 정리
    const [mr, vr, ar, pr] = await Promise.all([
      sb(`/rest/v1/group_members?group_id=eq.${s.group_id}&select=role,user_id,user:profiles!group_members_user_id_fkey(nickname)&order=joined_at.asc`),
      sb(`/rest/v1/group_story_versions?story_id=eq.${id}&select=n,note,created_at,created_by&order=n.desc&limit=20`),
      sb(`/rest/v1/group_story_activity?story_id=eq.${id}&select=action,k,data,created_at,user_id&order=created_at.desc&limit=60`),
      sb(`/rest/v1/group_publish_requests?story_id=eq.${id}&select=id,status,title,version_n,expires_at,post_id,proposer_id,consents:group_publish_consents(user_id,status)&order=created_at.desc&limit=1`),
    ]);
    const lastReq = pr.ok ? ((await pr.json())[0] || null) : null;
    const members = mr.ok ? await mr.json() : [];
    const versions = vr.ok ? await vr.json() : [];
    const activity = ar.ok ? await ar.json() : [];
    const reqConsents = (lastReq && lastReq.consents) || [];
    const N = await nicks([...scenes.flatMap(x => [x.assignee_id, x.lock_user, x.final_by]), ...versions.map(v => v.created_by), ...activity.map(a => a.user_id), ...members.map(m => m.user_id), ...reqConsents.map(c => c.user_id)]);
    const owner = role === 'owner';
    const canSeeDraft = x => owner || x.assignee_id === me || x.lock_user === me;
    const urls = await urlsFor(id, [s.common && s.common.charRef, ...scenes.flatMap(x => [x.final && x.final.image, canSeeDraft(x) && x.draft && x.draft.image])]);
    const now = Date.now();
    return json({
      story: { id: s.id, group_id: s.group_id, group_name: (s.group || {}).name || '', title: s.title, mode: s.mode,
        common: { ...(s.common || {}), charRef_url: s.common && s.common.charRef ? urls[s.common.charRef] || null : null } },
      my_role: role, me: who.profile.nickname,
      members: members.map(m => ({ nickname: (m.user || {}).nickname || '', role: m.role })),
      scenes: scenes.map(x => {
        const locked = !!(x.lock_user && x.lock_until && Date.parse(x.lock_until) > now);
        return {
          k: x.k, ord: x.ord, status: x.status, assignee: N[x.assignee_id] || null, is_mine: x.assignee_id === me,
          lock: locked ? { by: N[x.lock_user] || '', until: x.lock_until, mine: x.lock_user === me } : null,
          final: x.final ? { script: x.final.script || '', image_url: x.final.image ? urls[x.final.image] || null : null, image: x.final.image || null, by: N[x.final_by] || null } : null,
          draft: canSeeDraft(x) && x.draft ? { script: x.draft.script || '', image_url: x.draft.image ? urls[x.draft.image] || null : null, image: x.draft.image || null } : null,
          return_reason: x.return_reason || null,
        };
      }),
      versions: versions.map(v => ({ n: v.n, note: v.note || '', created_at: v.created_at, by: N[v.created_by] || '' })),
      activity: activity.map(a => ({ action: a.action, k: a.k, data: a.data, created_at: a.created_at, by: N[a.user_id] || '' })),
      publish: lastReq ? {
        id: lastReq.id, title: lastReq.title, version_n: lastReq.version_n, post_id: lastReq.post_id, expires_at: lastReq.expires_at,
        status: lastReq.status === 'pending' && Date.parse(lastReq.expires_at) < now ? 'expired' : lastReq.status,
        consents: reqConsents.map(c => ({ nickname: N[c.user_id] || '', status: c.status, mine: c.user_id === me })),
      } : null,
    });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const a = String(b.action || '');
  const sid = UUID.test(String(b.story_id || '')) ? b.story_id : null;
  const k = clean(b.k, 40);

  if (a === 'create') {
    if (!UUID.test(String(b.group_id || ''))) return fail('not_found', 404);
    const title = clean(b.title, 60);
    if (!title) return json({ error: '제목을 적어 주세요.', code: 'title_required' }, 400);
    if (hasBadWord(title)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    const scenes = Array.isArray(b.scenes) ? b.scenes.slice(0, 41).map((x, i) => ({ k: clean(x && x.k, 40) || 'x_' + (i + 1), ord: i, script: clean(x && x.script, 2000) })) : [];
    if (new Set(scenes.map(x => x.k)).size !== scenes.length) return fail('invalid_scenes');
    const c = b.common || {};
    const common = { logline: clean(c.logline, 500), charDesc: clean(c.charDesc, 500), style: clean(c.style, 40) || 'storybook', styleText: clean(c.styleText, 300),
      aspect: ASPECTS.includes(c.aspect) ? c.aspect : '4:3', charRef: null };
    return out(await rpc(env, 'gs_create', { p_user: me, p_group: b.group_id, p_mode: b.mode === 'long' ? 'long' : 'short', p_title: title, p_common: common, p_scenes: scenes }));
  }

  // 게시 동의·거절: 동의 목록에 있으면 그룹을 나갔어도 답할 수 있어 역할 확인보다 먼저
  if (a === 'respond_publish') {
    if (!UUID.test(String(b.request_id || ''))) return fail('not_found', 404);
    return out(await rpc(env, 'gp_respond', { p_user: me, p_request: b.request_id, p_agree: !!b.agree }));
  }

  if (!sid) return fail('not_found', 404);
  const role = await roleIn(sid);
  if (role === undefined) return json({ error: 'group_stories_not_ready' }, 503);
  if (!role) return fail('not_found', 404);

  if (a === 'asset') {
    if (role === 'viewer') return fail('no_permission', 403);
    const bytes = Number(b.bytes);
    if (!EXT[b.mime] || !SHA.test(String(b.sha256 || '')) || !Number.isInteger(bytes) || bytes < 1 || bytes > 10 * 1024 * 1024) return json({ error: '그림 파일이 올바르지 않아요.', code: 'invalid_file' }, 400);
    const ex = await sb(`/rest/v1/group_story_assets?story_id=eq.${sid}&sha256=eq.${b.sha256}&select=id,status,path`);
    const row = (ex.ok ? await ex.json() : [])[0];
    if (row && row.status === 'ready') return json({ exists: true, asset_id: row.id });
    if (row) { const t = await signUpload(env, row.path, BUCKET); return t ? json({ asset_id: row.id, path: row.path, token: t.token, bucket: BUCKET }) : json({ error: 'sign_failed' }, 500); }
    const rq = await rpc(env, 'reserve_quota', { p_owner: me, p_bytes: bytes });
    if (rq.data !== true) return fail('quota_exceeded', 413);
    const path = `${me}/groups/${sid}/${b.sha256}.${EXT[b.mime]}`;
    const ins = await sb('/rest/v1/group_story_assets', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ story_id: sid, uploader_id: me, path, mime: b.mime, bytes, sha256: b.sha256 }) });
    const insRows = ins.ok ? await ins.json() : null;
    if (!insRows || !insRows[0]) { await rpc(env, 'release_quota', { p_owner: me, p_bytes: bytes }); return json({ error: 'asset_failed' }, 500); }
    const t = await signUpload(env, path, BUCKET);
    if (!t) return json({ error: 'sign_failed' }, 500);
    return json({ asset_id: insRows[0].id, path, token: t.token, bucket: BUCKET });
  }
  if (a === 'asset_confirm') {
    if (!UUID.test(String(b.asset_id || ''))) return fail('not_found', 404);
    const r = await sb(`/rest/v1/group_story_assets?id=eq.${b.asset_id}&story_id=eq.${sid}&uploader_id=eq.${me}&select=id,path,bytes,status`);
    const row = (r.ok ? await r.json() : [])[0];
    if (!row) return fail('not_found', 404);
    if (row.status !== 'ready') {
      const info = await objectInfo(env, row.path, BUCKET);
      const size = info && Number(info.size != null ? info.size : (info.metadata && info.metadata.size));
      if (!info || size !== Number(row.bytes)) {
        await removeObjects(env, [row.path], BUCKET);
        await sb(`/rest/v1/group_story_assets?id=eq.${row.id}`, { method: 'DELETE' });
        await rpc(env, 'release_quota', { p_owner: me, p_bytes: row.bytes });
        return json({ error: '그림이 다 올라가지 않았어요. 다시 올려 주세요.', code: 'upload_incomplete' }, 400);
      }
      await sb(`/rest/v1/group_story_assets?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ready' }) });
    }
    return json({ ok: true, asset_id: row.id });
  }

  if (a === 'propose' || a === 'cancel_publish') {
    if (role !== 'owner') return fail('not_owner', 403);
    if (a === 'cancel_publish') {
      await sb(`/rest/v1/group_publish_requests?story_id=eq.${sid}&status=in.(pending,approved)`, { method: 'PATCH', body: JSON.stringify({ status: 'canceled', decided_at: new Date().toISOString() }) });
      return json({ ok: true });
    }
    const title = clean(b.title, 60), caption = clean(b.caption, 500);
    if (!title) return json({ error: '제목을 적어 주세요.', code: 'title_required' }, 400);
    if (hasBadWord(title) || hasBadWord(caption)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    return out(await rpc(env, 'gp_propose', { p_actor: me, p_story: sid, p_title: title, p_caption: caption,
      p_visibility: b.visibility === 'followers' ? 'followers' : 'public', p_cmode: ['followers', 'off'].includes(b.comments_mode) ? b.comments_mode : 'all' }));
  }

  if (a === 'update_common' || a === 'import_images' || a === 'restore' || a === 'delete') {
    if (role !== 'owner') return fail('not_owner', 403);
    if (a === 'restore') return out(await rpc(env, 'gs_restore', { p_actor: me, p_story: sid, p_n: parseInt(b.n, 10) || 0 }));
    if (a === 'delete') {
      await sb(`/rest/v1/group_stories?id=eq.${sid}`, { method: 'PATCH', body: JSON.stringify({ deleted_at: new Date().toISOString() }) });
      await rpc(env, 'gs_log', { p_story: sid, p_user: me, p_action: 'delete', p_k: null, p_data: null });
      return json({ ok: true });
    }
    // 그림 id 는 이 작품의 준비된 파일이어야 한다
    const readyIds = async ids => {
      ids = ids.filter(x => UUID.test(String(x || '')));
      if (!ids.length) return new Set();
      const r = await sb(`/rest/v1/group_story_assets?story_id=eq.${sid}&id=in.(${ids.join(',')})&status=eq.ready&select=id`);
      return new Set((r.ok ? await r.json() : []).map(x => x.id));
    };
    if (a === 'import_images') {
      const imgs = b.images && typeof b.images === 'object' ? b.images : {};
      const ok = await readyIds(Object.values(imgs));
      const cr = await sb(`/rest/v1/group_story_scenes?story_id=eq.${sid}&select=k,final`);
      let n = 0;
      for (const sc of (cr.ok ? await cr.json() : [])) {
        const img = imgs[sc.k];
        if (!img || !ok.has(img) || (sc.final && sc.final.image)) continue;
        await sb(`/rest/v1/group_story_scenes?story_id=eq.${sid}&k=eq.${encodeURIComponent(sc.k)}`, { method: 'PATCH',
          body: JSON.stringify({ final: { script: (sc.final && sc.final.script) || '', image: img }, status: 'approved', final_by: me, updated_at: new Date().toISOString() }) });
        n++;
      }
      if (n) await rpc(env, 'gs_snapshot', { p_story: sid, p_user: me, p_note: '가져온 그림 반영' });
      return json({ ok: true, count: n });
    }
    const c = b.common || {};
    const cur = await sb(`/rest/v1/group_stories?id=eq.${sid}&select=title,common`);
    const s = (cur.ok ? await cur.json() : [])[0] || { common: {} };
    const title = 'title' in b ? clean(b.title, 60) : s.title;
    if (!title) return json({ error: '제목을 적어 주세요.', code: 'title_required' }, 400);
    const common = { ...(s.common || {}) };
    for (const [key, n] of [['logline', 500], ['charDesc', 500], ['style', 40], ['styleText', 300]]) if (key in c) common[key] = clean(c[key], n);
    if ('aspect' in c && ASPECTS.includes(c.aspect)) common.aspect = c.aspect;
    if ('charRef' in c) {
      if (c.charRef === null) common.charRef = null;
      else if ((await readyIds([c.charRef])).has(c.charRef)) common.charRef = c.charRef;
      else return fail('invalid_image');
    }
    if (hasBadWord(title) || hasBadWord(common.logline) || hasBadWord(common.charDesc)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    await sb(`/rest/v1/group_stories?id=eq.${sid}`, { method: 'PATCH', body: JSON.stringify({ title, common, updated_at: new Date().toISOString() }) });
    await rpc(env, 'gs_log', { p_story: sid, p_user: me, p_action: 'settings', p_k: null, p_data: null });
    await rpc(env, 'gs_snapshot', { p_story: sid, p_user: me, p_note: '공통 설정 바꿈' });
    return json({ ok: true });
  }

  if (!k) return fail('not_found', 404);
  if (a === 'assign') {
    let uid = null;
    if (b.nickname) {
      const r = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(clean(b.nickname, 20))}&select=id`);
      uid = ((r.ok ? await r.json() : [])[0] || {}).id || null;
      if (!uid) return fail('not_found', 404);
    }
    return out(await rpc(env, 'gs_assign', { p_actor: me, p_story: sid, p_k: k, p_user: uid }));
  }
  if (a === 'lock') return out(await rpc(env, 'gs_lock', { p_user: me, p_story: sid, p_k: k }));
  if (a === 'unlock') return out(await rpc(env, 'gs_unlock', { p_user: me, p_story: sid, p_k: k }));
  if (a === 'save') {
    const script = clean(b.script, 2000);
    if (hasBadWord(script)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    return out(await rpc(env, 'gs_save_draft', { p_user: me, p_story: sid, p_k: k, p_draft: { script, image: UUID.test(String(b.image || '')) ? b.image : null } }));
  }
  if (a === 'submit') return out(await rpc(env, 'gs_submit', { p_user: me, p_story: sid, p_k: k }));
  if (a === 'review') {
    if (role !== 'owner') return fail('not_owner', 403);
    return out(await rpc(env, 'gs_review', { p_actor: me, p_story: sid, p_k: k, p_approve: !!b.approve, p_reason: clean(b.reason, 300) }));
  }
  return json({ error: 'unknown_action' }, 400);
}
