// 게임 방 (5단계 — 게임 자체는 없음. 방·입장 코드·초대·준비·시작·결과의 공통 틀)
// 스위치 GAMES_ENABLED: 'on' = 회원 모두 / 'beta' = profiles.role='admin' 회원만 / 그 외 = 꺼짐. 비회원은 쓸 수 없음.
//  GET  /api/game-rooms?games=1           쓸 수 있는 게임 목록 (스위치 확인용으로도 씀)
//  GET  /api/game-rooms                   내가 들어가 있는 방 (기다리는 중·진행 중)
//  GET  /api/game-rooms?id=uuid[&since=n] 방 자세히. since 가 지금 버전과 같으면 {unchanged:true} 만 (몇 초마다 물어봐도 가볍게)
//  POST /api/game-rooms {action, ...}
//    create {game, max_players?} / join {code} / invite {room_id, nickname} / leave {room_id} / kick {room_id, nickname}
//    ready {room_id, ready} / start {room_id} / state {room_id, state, version} / end {room_id, results:[{nickname, rank?, score?}]}
// 채팅은 없음(학생 보호). 초대는 서로 팔로우하거나 같은 그룹인 사람만(DB 함수에서 확인).
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, rpc, UUID, gamesMode } from './_lib/social.js';

const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const ERR = {
  game_not_found: '지금은 쓸 수 없는 게임이에요.', sanctioned: '지금은 이용 제한 중이라 할 수 없어요.',
  too_many_rooms: '한 번에 들어가 있을 수 있는 방은 3개까지예요. 다른 방에서 나와 주세요.',
  daily_room_limit: '오늘은 방을 더 만들 수 없어요. 내일 다시 해 주세요.', try_again: '잠시 뒤 다시 해 주세요.',
  room_not_found: '방을 찾을 수 없어요. 입장 코드를 다시 확인해 주세요.', kicked: '이 방에는 다시 들어갈 수 없어요.',
  already_started: '이미 시작했거나 끝난 방이에요.', room_full: '방이 꽉 찼어요.', not_host: '방장만 할 수 있어요.',
  user_not_found: '그 닉네임을 찾을 수 없어요.', not_friend: '서로 팔로우하는 친구나 같은 그룹 친구만 초대할 수 있어요.',
  already_member: '이미 방에 있는 친구예요.', not_member: '방에 들어가 있지 않아요.',
  not_enough_players: '사람이 더 필요해요.', not_all_ready: '모두 준비해야 시작할 수 있어요.',
  not_playing: '진행 중인 게임이 아니에요.', version_conflict: '그사이 바뀐 내용이 있어요. 다시 해 주세요.',
  state_too_large: '게임 정보가 너무 커요.',
};

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 32 * 1024, cors);
  if (bad) return bad;
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);

  const mode = gamesMode(env);
  const who = await whoIs(request, env);
  const isAdminRole = !!(who.profile && who.profile.role === 'admin');
  const allowed = who.admin || mode === 'on' || (mode === 'beta' && isAdminRole);
  if (!allowed) return json({ error: mode === 'beta' ? '지금은 일부 회원만 쓸 수 있는 준비 중 기능이에요.' : '아직 준비 중인 기능이에요.', code: 'games_disabled' }, 404);
  if (!who.user || !who.profile) return json({ error: '로그인하면 게임을 할 수 있어요.', code: 'login_required' }, 401);
  const me = who.user.id;
  const sb = makeSb(env);
  const fail = (code, status = 400, extra) => json({ error: ERR[code] || code, code, ...(extra || {}) }, status);
  const out = res => {
    if (res.missing) return json({ error: 'games_not_ready' }, 503);
    if (!res.data) return json({ error: 'failed' }, 500);
    if (!res.data.ok) return fail(res.data.error, res.data.error === 'not_host' ? 403 : res.data.error === 'room_not_found' ? 404 : 400, res.data.min ? { min: res.data.min } : null);
    return json(res.data);
  };
  const idByNick = async n => {
    n = String(n || '').trim();
    if (!/^[0-9A-Za-z가-힣_]{2,20}$/.test(n)) return null;
    const r = await sb(`/rest/v1/profiles?nickname=eq.${encodeURIComponent(n)}&select=id`);
    return ((r.ok ? await r.json() : [])[0] || {}).id || null;
  };

  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('games') === '1') {
      if (Math.random() < 0.02) await rpc(env, 'gm_housekeeping', {}).catch(() => null);   // 가끔 오래된 방 정리
      const r = await sb(`/rest/v1/games?status=in.(${isAdminRole || who.admin ? 'beta,on' : 'on'})&select=key,title,status,min_players,max_players&order=sort.asc`);
      if (r.status === 404 || r.status === 400) return json({ error: 'games_not_ready' }, 503);
      return json({ games: r.ok ? await r.json() : [] });
    }
    const id = url.searchParams.get('id');
    if (!id) {
      const r = await sb(`/rest/v1/game_room_members?user_id=eq.${me}&left_at=is.null&select=role,room:game_rooms(id,status,join_code,expires_at,updated_at,game:games(title))&order=joined_at.desc&limit=20`);
      if (r.status === 404 || r.status === 400) return json({ error: 'games_not_ready' }, 503);
      const now = Date.now();
      const rooms = (r.ok ? await r.json() : []).map(x => x.room).filter(x => x && (x.status === 'playing' || (x.status === 'waiting' && Date.parse(x.expires_at) > now)));
      return json({ rooms: rooms.map(x => ({ id: x.id, status: x.status, code: x.join_code, game: (x.game || {}).title || '', expires_at: x.expires_at })) });
    }
    if (!UUID.test(id)) return fail('room_not_found', 404);
    const rr = await sb(`/rest/v1/game_rooms?id=eq.${id}&select=*,game:games(key,title,min_players,max_players)`);
    if (rr.status === 404 || rr.status === 400) return json({ error: 'games_not_ready' }, 503);
    let room = (rr.ok ? await rr.json() : [])[0];
    if (!room) return fail('room_not_found', 404);
    const mr = await sb(`/rest/v1/game_room_members?room_id=eq.${id}&select=user_id,role,ready,left_at,joined_at,user:profiles(nickname,avatar_url)&order=joined_at.asc`);
    const all = mr.ok ? await mr.json() : [];
    const mine = all.find(m => m.user_id === me);
    // 지금 들어가 있는 사람만 볼 수 있음. 끝난 방은 참가했던 사람이 결과를 볼 수 있음
    if (!mine || (mine.left_at && room.status !== 'ended')) return fail('room_not_found', 404);
    if (room.status === 'waiting' && Date.parse(room.expires_at) < Date.now()) {
      await rpc(env, 'gm_expire', { p_room: id });
      room = { ...room, status: 'closed', version: room.version + 1 };
    }
    const since = parseInt(url.searchParams.get('since') || '', 10);
    if (since === room.version) return json({ unchanged: true, version: room.version });
    let results = [];
    if (room.status === 'ended') {
      const xr = await sb(`/rest/v1/game_results?room_id=eq.${id}&select=user_id,rank,score,user:profiles(nickname)&order=rank.asc.nullslast`);
      results = (xr.ok ? await xr.json() : []).map(x => ({ nickname: (x.user || {}).nickname || '', rank: x.rank, score: x.score == null ? null : Number(x.score), me: x.user_id === me }));
    }
    const active = all.filter(m => !m.left_at);
    return json({
      id: room.id, version: room.version, status: room.status, code: room.status === 'waiting' ? room.join_code : null,
      game: room.game, max_players: room.max_players, state: room.state || {}, expires_at: room.expires_at,
      started_at: room.started_at, ended_at: room.ended_at,
      my_role: mine.left_at ? null : mine.role, me: who.profile.nickname,
      members: active.map(m => ({ nickname: (m.user || {}).nickname || '', avatar_url: (m.user || {}).avatar_url || null, role: m.role, ready: m.ready, me: m.user_id === me })),
      results,
    });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const a = String(b.action || '');
  if (a === 'create') {
    const game = String(b.game || '');
    if (!/^[a-z0-9_]{2,30}$/.test(game)) return fail('game_not_found');
    // 베타 게임은 관리자 역할 회원만
    const gr = await sb(`/rest/v1/games?key=eq.${game}&select=status`);
    const g = (gr.ok ? await gr.json() : [])[0];
    if (!g || g.status === 'off' || (g.status === 'beta' && !isAdminRole && !who.admin)) return fail('game_not_found');
    const max = parseInt(b.max_players, 10);
    return out(await rpc(env, 'gm_create', { p_user: me, p_game: game, p_max: max >= 1 && max <= 8 ? max : null }));
  }
  if (a === 'join') {
    const code = String(b.code || '').trim().toUpperCase();
    if (!CODE.test(code)) return fail('room_not_found', 404);
    return out(await rpc(env, 'gm_join', { p_user: me, p_code: code }));
  }
  const room = UUID.test(String(b.room_id || '')) ? b.room_id : null;
  if (!room) return fail('room_not_found', 404);
  if (a === 'invite') {
    const uid = await idByNick(b.nickname);
    if (!uid) return fail('user_not_found', 404);
    return out(await rpc(env, 'gm_invite', { p_actor: me, p_room: room, p_invitee: uid }));
  }
  if (a === 'leave') return out(await rpc(env, 'gm_leave', { p_user: me, p_room: room }));
  if (a === 'kick') {
    const uid = await idByNick(b.nickname);
    if (!uid) return fail('not_member');
    return out(await rpc(env, 'gm_kick', { p_actor: me, p_room: room, p_target: uid }));
  }
  if (a === 'ready') return out(await rpc(env, 'gm_ready', { p_user: me, p_room: room, p_ready: !!b.ready }));
  if (a === 'start') return out(await rpc(env, 'gm_start', { p_actor: me, p_room: room }));
  if (a === 'state') {
    const v = parseInt(b.version, 10);
    if (!b.state || typeof b.state !== 'object' || Array.isArray(b.state) || !Number.isInteger(v)) return json({ error: 'invalid_state' }, 400);
    return out(await rpc(env, 'gm_set_state', { p_actor: me, p_room: room, p_state: b.state, p_version: v }));
  }
  if (a === 'end') {
    const list = Array.isArray(b.results) ? b.results.slice(0, 8) : [];
    const results = [];
    for (const x of list) {
      const uid = await idByNick(x && x.nickname);
      if (!uid) continue;
      const rank = Number.isInteger(x.rank) && x.rank >= 1 && x.rank <= 100 ? x.rank : null;
      const score = typeof x.score === 'number' && isFinite(x.score) && Math.abs(x.score) < 1e9 ? x.score : null;
      results.push({ user_id: uid, rank, score });
    }
    return out(await rpc(env, 'gm_end', { p_actor: me, p_room: room, p_results: results }));
  }
  return json({ error: 'unknown_action' }, 400);
}
