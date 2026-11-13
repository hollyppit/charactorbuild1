// 그룹 (4단계-A)
//  GET  /api/groups                내 그룹 목록 + 나에게 온 초대
//  GET  /api/groups?id=uuid        그룹 자세히 (그룹원만): 그룹원·역할, 모둠장에게는 보낸 초대 목록
//  POST /api/groups {action, ...}
//    create {name, intro?} / update {group_id, name?, intro?} / delete {group_id}
//    invite {group_id, nickname, role:'editor'|'viewer'} / cancel_invite {invite_id}
//    respond {invite_id, accept:true|false}
//    role {group_id, nickname, role:'editor'|'viewer'|'owner'(넘기기)} / remove {group_id, nickname} / leave {group_id}
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, disabledReply, rpc, UUID } from './_lib/social.js';
import { hasBadWord } from './_lib/words.js';

const NICK_RE = /^[0-9A-Za-z가-힣_]{2,20}$/;
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const ERR = {
  sanctioned: '지금은 이용 제한 중이라 할 수 없어요.',
  group_limit: '그룹은 한 사람이 5개까지 들어갈 수 있어요.',
  not_owner: '모둠장만 할 수 있어요.',
  not_found: '사람이나 그룹을 찾을 수 없어요.',
  already_member: '이미 그룹에 있는 친구예요.',
  already_invited: '이미 초대를 보냈어요. 친구가 답할 때까지 기다려 주세요.',
  group_full: '그룹은 10명까지예요 (초대 대기 포함).',
  group_gone: '그룹이 없어졌어요.',
  not_member: '그룹에 없는 사람이에요.',
  owner_must_transfer: '모둠장은 다른 사람에게 모둠장을 넘긴 뒤에 나갈 수 있어요.',
  invalid_role: '역할을 다시 골라 주세요.',
};

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 4096, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const who = await whoIs(request, env);
  if (!who.allowed) return disabledReply(json, who.mode);
  if (!who.user || !who.profile) return json({ error: '로그인이 필요해요.', code: 'login_required' }, 401);
  const me = who.user.id;
  const sb = makeSb(env);
  const fail = (code, status = 400) => json({ error: ERR[code] || code, code }, status);
  const result = (res, okExtra) => {
    if (res.missing) return json({ error: 'groups_not_ready' }, 503);
    if (!res.data) return json({ error: 'group_failed' }, 500);
    if (!res.data.ok) return fail(res.data.error, res.data.error === 'not_owner' ? 403 : res.data.error === 'not_found' ? 404 : 400);
    return json({ ok: true, ...(okExtra || {}), ...res.data });
  };
  const userByNick = async n => {
    if (!NICK_RE.test(String(n || '').trim())) return null;
    const r = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(String(n).trim())}&select=id`);
    return ((r.ok ? await r.json() : [])[0] || {}).id || null;
  };

  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      if (!UUID.test(id)) return fail('not_found', 404);
      const [gr, mr] = await Promise.all([
        sb(`/rest/v1/groups?id=eq.${id}&deleted_at=is.null&select=id,name,intro,owner_id,created_at`),
        sb(`/rest/v1/group_members?group_id=eq.${id}&select=role,joined_at,user_id,user:profiles!group_members_user_id_fkey(nickname,avatar_url)&order=joined_at.asc`),
      ]);
      if (gr.status === 404 || gr.status === 400) return json({ error: 'groups_not_ready' }, 503);
      const g = (gr.ok ? await gr.json() : [])[0];
      const members = mr.ok ? await mr.json() : [];
      const mine = members.find(m => m.user_id === me);
      if (!g || !mine) return fail('not_found', 404);   // 그룹원만 볼 수 있음
      let invites = [];
      if (mine.role === 'owner') {
        const ir = await sb(`/rest/v1/group_invites?group_id=eq.${id}&status=eq.pending&select=id,role,created_at,invitee:profiles!group_invites_invitee_id_fkey(nickname,avatar_url)&order=created_at.asc`);
        invites = (ir.ok ? await ir.json() : []).map(x => ({ id: x.id, role: x.role, created_at: x.created_at, nickname: (x.invitee || {}).nickname || '', avatar_url: (x.invitee || {}).avatar_url || null }));
      }
      return json({
        group: { id: g.id, name: g.name, intro: g.intro || '', created_at: g.created_at }, my_role: mine.role,
        members: members.map(m => ({ nickname: (m.user || {}).nickname || '', avatar_url: (m.user || {}).avatar_url || null, role: m.role, joined_at: m.joined_at, is_me: m.user_id === me })),
        invites,
      });
    }
    const [mr, ir] = await Promise.all([
      sb(`/rest/v1/group_members?user_id=eq.${me}&select=role,group:groups!inner(id,name,intro,deleted_at)&group.deleted_at=is.null`),
      sb(`/rest/v1/group_invites?invitee_id=eq.${me}&status=eq.pending&select=id,role,created_at,group:groups!inner(id,name,deleted_at),inviter:profiles!group_invites_inviter_id_fkey(nickname)&group.deleted_at=is.null&order=created_at.desc`),
    ]);
    if (mr.status === 404 || mr.status === 400) return json({ error: 'groups_not_ready' }, 503);
    const mine = (mr.ok ? await mr.json() : []).filter(x => x.group);
    const ids = mine.map(x => x.group.id);
    const counts = {};
    if (ids.length) {
      const cr = await sb(`/rest/v1/group_members?group_id=in.(${ids.join(',')})&select=group_id`);
      (cr.ok ? await cr.json() : []).forEach(x => { counts[x.group_id] = (counts[x.group_id] || 0) + 1; });
    }
    return json({
      groups: mine.map(x => ({ id: x.group.id, name: x.group.name, intro: x.group.intro || '', my_role: x.role, member_count: counts[x.group.id] || 1 })),
      invites: (ir.ok ? await ir.json() : []).filter(x => x.group).map(x => ({ id: x.id, role: x.role, created_at: x.created_at, group_id: x.group.id, group_name: x.group.name, inviter: (x.inviter || {}).nickname || '' })),
    });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const a = String(b.action || '');
  const gid = UUID.test(String(b.group_id || '')) ? b.group_id : null;

  if (a === 'create' || a === 'update') {
    const name = clean(b.name, 30), intro = clean(b.intro, 200);
    if (a === 'create' || 'name' in b) { if (name.length < 2) return json({ error: '그룹 이름은 2~30자로 적어 주세요.', code: 'invalid_name' }, 400); }
    if (hasBadWord(name) || hasBadWord(intro)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    if (a === 'create') return result(await rpc(env, 'group_create', { p_owner: me, p_name: name, p_intro: intro }));
    if (!gid) return fail('not_found', 404);
    const patch = { updated_at: new Date().toISOString() };
    if ('name' in b) patch.name = name;
    if ('intro' in b) patch.intro = intro || null;
    const r = await sb(`/rest/v1/groups?id=eq.${gid}&owner_id=eq.${me}&deleted_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    return (r.ok && (await r.json()).length) ? json({ ok: true }) : fail('not_owner', 403);
  }
  if (a === 'delete') { if (!gid) return fail('not_found', 404); return result(await rpc(env, 'group_delete', { p_actor: me, p_group: gid })); }
  if (a === 'invite') {
    if (!gid) return fail('not_found', 404);
    const uid = await userByNick(b.nickname);
    if (!uid) return fail('not_found', 404);
    return result(await rpc(env, 'group_invite', { p_actor: me, p_group: gid, p_invitee: uid, p_role: b.role === 'viewer' ? 'viewer' : 'editor' }));
  }
  if (a === 'cancel_invite') {
    if (!UUID.test(String(b.invite_id || ''))) return fail('not_found', 404);
    const ir = await sb(`/rest/v1/group_invites?id=eq.${b.invite_id}&status=eq.pending&select=group_id`);
    const inv = (ir.ok ? await ir.json() : [])[0];
    if (!inv) return fail('not_found', 404);
    const gr = await sb(`/rest/v1/groups?id=eq.${inv.group_id}&owner_id=eq.${me}&select=id`);
    if (!(gr.ok ? await gr.json() : []).length) return fail('not_owner', 403);
    await sb(`/rest/v1/group_invites?id=eq.${b.invite_id}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ status: 'canceled', responded_at: new Date().toISOString() }) });
    return json({ ok: true });
  }
  if (a === 'respond') {
    if (!UUID.test(String(b.invite_id || ''))) return fail('not_found', 404);
    return result(await rpc(env, 'group_respond', { p_user: me, p_invite: b.invite_id, p_accept: !!b.accept }));
  }
  if (a === 'role' || a === 'remove') {
    if (!gid) return fail('not_found', 404);
    const uid = await userByNick(b.nickname);
    if (!uid) return fail('not_found', 404);
    if (a === 'role') return result(await rpc(env, 'group_set_role', { p_actor: me, p_group: gid, p_user: uid, p_role: String(b.role || '') }));
    return result(await rpc(env, 'group_remove', { p_actor: me, p_group: gid, p_user: uid }));
  }
  if (a === 'leave') { if (!gid) return fail('not_found', 404); return result(await rpc(env, 'group_remove', { p_actor: me, p_group: gid, p_user: me })); }
  return json({ error: 'unknown_action' }, 400);
}
