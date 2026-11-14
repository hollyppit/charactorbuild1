// 게임 방 (5단계 — 게임 자체는 없음. 방·입장 코드·초대·준비·시작·결과의 공통 틀)
// 스위치 GAMES_ENABLED: 'on' = 회원 모두 / 'beta' = profiles.role='admin' 회원만 / 그 외 = 꺼짐. 비회원은 쓸 수 없음.
//  GET  /api/game-rooms?games=1           쓸 수 있는 게임 목록 (스위치 확인용으로도 씀)
//  GET  /api/game-rooms                   내가 들어가 있는 방 (기다리는 중·진행 중)
//  GET  /api/game-rooms?id=uuid[&since=n] 방 자세히. since 가 지금 버전과 같으면 {unchanged:true} 만 (몇 초마다 물어봐도 가볍게)
//  POST /api/game-rooms {action, ...}
//    create {game, max_players?} / join {code} / invite {room_id, nickname} / leave {room_id} / kick {room_id, nickname}
//    ready {room_id, ready} / start {room_id} / state {room_id, state, version} / end {room_id, results:[{nickname, rank?, score?}]}
//    (그림 릴레이 draw_relay) submit {room_id, step, image|choice} / tick {room_id}  — 진행·점수는 DB 함수(gd_*)가 판단
//    (기억 조각 그림 memory_parts) submit {room_id, round, image|choice} / tick {room_id} — DB 함수(mp_*)
//    (쓱싹 퀴즈 sketch_quiz) start {room_id, laps:1|2} / pick {room_id, turn, word} / stroke {room_id, turn, data:[획 조각]} / guess {room_id, turn, text} / tick — DB 함수(qd_*)
//  GET  ?id=&since=n&sk=마지막 획 id   쓱싹 퀴즈는 버전이 같아도 새 획(strokes)을 함께 줌 / ?id=&strokes_turn=t  끝난 뒤 그 차례의 획 전체
//  GET  /api/game-rooms?records=1         내 기록(게임별 판 수·1등·최고 점수·최근 5판) — 나만 봄
// 채팅은 없음(학생 보호). 초대는 서로 팔로우하거나 같은 그룹인 사람만(DB 함수에서 확인).
import { corsHeaders, jsonResponder, checkOrigin, checkSize, makeSb } from './_lib/common.js';
import { whoIs, rpc, UUID, gamesMode } from './_lib/social.js';
import { hasBadWord } from './_lib/words.js';

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
  too_fast: '조금 천천히 입력해 주세요.',
  step_over: '이번 차례가 이미 끝났어요.', invalid_image: '그림을 다시 내 주세요.', invalid_choice: '보기 중에서 골라 주세요.', not_player: '이번 게임 참가자가 아니에요.',
};

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 256 * 1024, cors);
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

  // 그림 릴레이 화면 정보: 진행 중에는 내 차례 것만(제시어·앞 그림·보기), 끝나면 줄마다 바뀐 과정 전체
  async function relayView(room, all) {
    const st = room.state, order = st.order || [], n = st.steps, s = st.step;
    const nick = Object.fromEntries(all.map(m => [m.user_id, (m.user || {}).nickname || '']));
    if (st.phase === 'play' && room.status === 'playing') {
      const u = order.indexOf(me);
      const c = u < 0 ? null : ((u - s) % n + n) % n;
      const kind = s < n - 1 ? 'draw' : 'guess';
      const activeIds = new Set(all.filter(m => !m.left_at).map(m => m.user_id));
      const [er, cr, pr] = await Promise.all([
        sb(`/rest/v1/gd_entries?room_id=eq.${room.id}&step=eq.${s}&select=chain,user_id`),
        c == null ? null : sb(`/rest/v1/gd_chains?room_id=eq.${room.id}&chain=eq.${c}&select=word,options`),
        c == null || s === 0 ? null : sb(`/rest/v1/gd_entries?room_id=eq.${room.id}&chain=eq.${c}&step=lt.${s}&image=not.is.null&select=image,step&order=step.desc&limit=1`),
      ]);
      const done = er && er.ok ? await er.json() : [];
      const ch = cr && cr.ok ? (await cr.json())[0] || {} : {};
      const prev = pr && pr.ok ? (await pr.json())[0] || null : null;
      return {
        phase: 'play', step: s, steps: n, kind, remaining_ms: Math.max(0, Date.parse(st.deadline) - Date.now()),
        playing: u >= 0, submitted: done.some(x => x.user_id === me),
        done: done.filter(x => activeIds.has(x.user_id)).length, need: order.filter(x => activeIds.has(x)).length,
        word: s === 0 && kind === 'draw' ? ch.word || null : null,
        prev_image: s > 0 ? (prev ? prev.image : null) : null,
        options: kind === 'guess' ? ch.options || [] : null,
      };
    }
    const [cr, er] = await Promise.all([
      sb(`/rest/v1/gd_chains?room_id=eq.${room.id}&select=chain,word&order=chain.asc`),
      sb(`/rest/v1/gd_entries?room_id=eq.${room.id}&select=chain,step,user_id,kind,image,choice&order=step.asc`),
    ]);
    const chains = cr.ok ? await cr.json() : [], entries = er.ok ? await er.json() : [];
    return {
      phase: 'reveal', steps: n, kept: entries.length > 0,
      chains: chains.map(c => {
        const items = entries.filter(e => e.chain === c.chain).map(e => ({ step: e.step, nickname: nick[e.user_id] || '(나간 친구)', mine: e.user_id === me, kind: e.kind, image: e.image || null, choice: e.choice || null }));
        const g = items.find(x => x.kind === 'guess');
        return { word: c.word, starter: nick[order[c.chain]] || '', items, correct: !!(g && g.choice === c.word) };
      }),
    };
  }

  // 기억 조각 그림 화면 정보: 단계·역할에 따라 필요한 것만 (캐릭터 그림은 show 단계의 그리는 사람에게만)
  async function memoryView(room, all) {
    const st = room.state, order = st.order || [], rd = st.round, ph = st.phase;
    const nick = Object.fromEntries(all.map(m => [m.user_id, (m.user || {}).nickname || '']));
    const activeIds = new Set(all.filter(m => !m.left_at).map(m => m.user_id));
    // 그림 내용은 맞히기·결과·다시 보기 단계에서만 보냄 (그리는 동안에는 누가 냈는지만)
    const withImg = ph === 'reveal' || ph === 'guess' || ph === 'result' || room.status !== 'playing';
    const [rr, pr] = await Promise.all([
      sb(`/rest/v1/mp_rounds?room_id=eq.${room.id}&select=round,guesser_id,char_id,options,guess_id,correct&order=round.asc`),
      sb(`/rest/v1/mp_parts?room_id=eq.${room.id}${room.status === 'playing' && ph !== 'reveal' ? '&round=eq.' + rd : ''}&select=round,user_id,part${withImg ? ',image' : ''}`),
    ]);
    const rounds = rr.ok ? await rr.json() : [];
    const parts = pr.ok ? await pr.json() : [];
    const ids = [...new Set(rounds.flatMap(x => [x.char_id, ...(x.options || [])]))];
    let chars = {};
    if (ids.length) {
      const cr = await sb(`/rest/v1/char_items?id=in.(${ids.map(x => encodeURIComponent('"' + String(x).replace(/"/g, '') + '"')).join(',')})&select=id,label,src`);
      chars = Object.fromEntries((cr.ok ? await cr.json() : []).map(c => [c.id, { id: c.id, label: c.label || '', src: c.src || '' }]));
    }
    const ch = id => chars[id] || { id, label: '?', src: '' };
    const drawersOf = g => order.filter(u => u !== g);
    const K = Math.min(4, Math.max(1, order.length - 1));
    const partOf = (x, u) => { const d = drawersOf(x.guesser_id); const i = d.indexOf(u); return i < 0 ? null : (i + x.round) % K; };
    const roundParts = x => parts.filter(p => p.round === x.round).sort((a, b) => a.part - b.part).map(p => ({ part: p.part, image: p.image || null, nickname: nick[p.user_id] || '(나간 친구)', mine: p.user_id === me }));
    if (ph === 'reveal' || room.status !== 'playing') {
      return { phase: 'reveal', K, kept: parts.length > 0, rounds: rounds.map(x => ({
        round: x.round, guesser: nick[x.guesser_id] || '(나간 친구)', answer: ch(x.char_id), guess: x.guess_id ? ch(x.guess_id) : null, correct: !!x.correct, parts: roundParts(x),
      })) };
    }
    const x = rounds.find(y => y.round === rd) || {};
    const role = !order.includes(me) ? 'watch' : x.guesser_id === me ? 'guesser' : 'drawer';
    const drawers = drawersOf(x.guesser_id).filter(u => activeIds.has(u));
    const out = {
      phase: ph, round: rd, rounds: st.rounds, K, role, guesser: nick[x.guesser_id] || '', remaining_ms: Math.max(0, Date.parse(st.deadline) - Date.now()),
      my_part: role === 'drawer' ? partOf(x, me) : null,
      submitted: role === 'drawer' ? parts.some(p => p.round === rd && p.user_id === me) : role === 'guesser' ? !!x.guess_id : false,
      done: parts.filter(p => p.round === rd && drawers.includes(p.user_id)).length, need: drawers.length,
    };
    if (ph === 'show' && role === 'drawer') out.character = ch(x.char_id);
    if (ph === 'guess' || ph === 'result') out.parts = roundParts(x);
    if (ph === 'guess' && role === 'guesser') out.options = (x.options || []).map(ch);
    if (ph === 'result') { out.answer = ch(x.char_id); out.guess = x.guess_id ? ch(x.guess_id) : null; out.correct = !!x.correct; }
    return out;
  }

  // 쓱싹 퀴즈 화면 정보: 제시어는 그리는 사람에게만(맞히는 사람은 글자 수·절반 지나면 첫 글자), 차례가 끝나면 모두에게
  async function sketchView(room, all) {
    const st = room.state, order = st.order || [], t = st.turn, ph = st.phase;
    const nick = Object.fromEntries(all.map(m => [m.user_id, (m.user || {}).nickname || '']));
    const [tr, hr] = await Promise.all([
      sb(`/rest/v1/qd_turns?room_id=eq.${room.id}&select=turn,drawer_id,choices,word,draw_started&order=turn.asc`),
      sb(`/rest/v1/qd_hits?room_id=eq.${room.id}&select=turn,user_id,points,at&order=at.asc`),
    ]);
    const turns = tr.ok ? await tr.json() : [], hits = hr.ok ? await hr.json() : [];
    const hitsOf = n => hits.filter(h => h.turn === n).map(h => ({ nickname: nick[h.user_id] || '(나간 친구)', points: h.points, me: h.user_id === me }));
    if (ph === 'reveal' || room.status !== 'playing') {
      return { phase: 'reveal', turns: turns.filter(x => x.word).map(x => ({ turn: x.turn, drawer: nick[x.drawer_id] || '(나간 친구)', mine: x.drawer_id === me, word: x.word, hits: hitsOf(x.turn) })) };
    }
    const x = turns.find(y => y.turn === t) || {};
    const role = x.drawer_id === me ? 'drawer' : order.includes(me) ? 'guesser' : 'watch';
    const out = { phase: ph, turn: t, turns: st.turns, laps: st.laps, drawer: nick[x.drawer_id] || '', role,
      remaining_ms: Math.max(0, Date.parse(st.deadline) - Date.now()), hits: hitsOf(t), my_hit: (hits.find(h => h.turn === t && h.user_id === me) || {}).points || null };
    if (ph === 'pick' && role === 'drawer') out.choices = x.choices || [];
    if (ph === 'draw' && x.word) {
      if (role === 'drawer' || out.my_hit) out.word = x.word;
      const chars = [...x.word];
      const half = x.draw_started && (Date.now() - Date.parse(x.draw_started)) >= (st.draw_sec * 1000) / 2;
      out.hint = chars.map((c, i) => c === ' ' ? ' ' : (half && i === 0 ? c : '○')).join('');
      out.hint_first = !!half;
    }
    if (ph === 'turn_end') out.word = x.word || null;
    return out;
  }
  // 획 조각 정리: 선(번호·색·굵기·좌표)과 되돌리기/지우기만 남김 (다른 친구 화면으로 가는 내용이라 형식을 엄격히)
  function cleanStrokes(data) {
    if (!Array.isArray(data) || data.length > 60) return null;
    const out = []; let pts = 0;
    for (const it of data) {
      if (it && (it.op === 'undo' || it.op === 'clear')) { out.push({ op: it.op }); continue; }
      if (!it || !Number.isInteger(it.i) || it.i < 0 || it.i > 100000 || !/^#[0-9a-fA-F]{6}$/.test(String(it.c)) || !(Number(it.s) >= 1 && Number(it.s) <= 40) || !Array.isArray(it.p)) return null;
      const p = [];
      for (const q of it.p) {
        if (!Array.isArray(q) || q.length !== 2) return null;
        const x = Math.round(Number(q[0])), y = Math.round(Number(q[1]));
        if (!(x >= -10 && x <= 490 && y >= -10 && y <= 370)) return null;
        p.push([x, y]);
      }
      pts += p.length; if (!p.length || pts > 1500) return null;
      out.push({ i: it.i, c: String(it.c).toLowerCase(), s: Math.round(Number(it.s) * 10) / 10, p });
    }
    return out;
  }

  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('games') === '1') {
      if (Math.random() < 0.02) await rpc(env, 'gm_housekeeping', {}).catch(() => null);   // 가끔 오래된 방 정리
      const r = await sb(`/rest/v1/games?status=in.(${isAdminRole || who.admin ? 'beta,on' : 'on'})&select=key,title,status,min_players,max_players&order=sort.asc`);
      if (r.status === 404 || r.status === 400) return json({ error: 'games_not_ready' }, 503);
      return json({ games: r.ok ? await r.json() : [] });
    }
    if (url.searchParams.get('records') === '1') {
      const r = await sb(`/rest/v1/game_results?user_id=eq.${me}&select=rank,score,created_at,room:game_rooms(game_key,game:games(title))&order=created_at.desc&limit=500`);
      if (r.status === 404 || r.status === 400) return json({ error: 'games_not_ready' }, 503);
      const by = {};
      for (const x of (r.ok ? await r.json() : [])) {
        const k = (x.room || {}).game_key; if (!k) continue;
        const g = by[k] = by[k] || { key: k, title: ((x.room || {}).game || {}).title || k, played: 0, wins: 0, best: null, recent: [] };
        g.played++; if (x.rank === 1) g.wins++;
        const sc = x.score == null ? null : Number(x.score);
        if (sc != null && (g.best == null || sc > g.best)) g.best = sc;
        if (g.recent.length < 5) g.recent.push({ at: x.created_at, rank: x.rank, score: sc });
      }
      return json({ records: Object.values(by) });
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
    // 그림 릴레이: 마감이 지났으면 다음 단계로 넘기고 다시 읽음 (서버 시간 기준)
    const ADV = { draw_relay: 'gd_advance', memory_parts: 'mp_advance', sketch_quiz: 'qd_advance' };
    if (ADV[room.game_key] && room.status === 'playing' && room.state && room.state.deadline && room.state.phase !== 'reveal' && Date.parse(room.state.deadline) <= Date.now()) {
      await rpc(env, ADV[room.game_key], { p_room: id });
      const again = await sb(`/rest/v1/game_rooms?id=eq.${id}&select=*,game:games(key,title,min_players,max_players)`);
      room = (again.ok ? await again.json() : [])[0] || room;
    }
    if (room.game_key === 'sketch_quiz' && url.searchParams.get('strokes_turn') != null) {
      const t = parseInt(url.searchParams.get('strokes_turn'), 10);
      if (!Number.isInteger(t) || t < 0 || t > 15) return fail('step_over');
      const sr = await sb(`/rest/v1/qd_strokes?room_id=eq.${id}&turn=eq.${t}&select=id,data&order=id.asc&limit=1000`);
      return json({ turn: t, strokes: sr.ok ? await sr.json() : [] });
    }
    // 쓱싹 퀴즈: 그리는 중이면 버전과 상관없이 마지막으로 받은 획 뒤의 새 획을 붙여 줌
    let strokes;
    if (room.game_key === 'sketch_quiz' && room.status === 'playing' && room.state && room.state.phase === 'draw') {
      const sk = parseInt(url.searchParams.get('sk') || '0', 10) || 0;
      const sr = await sb(`/rest/v1/qd_strokes?room_id=eq.${id}&turn=eq.${room.state.turn}&id=gt.${sk}&select=id,data&order=id.asc&limit=300`);
      strokes = { turn: room.state.turn, items: sr.ok ? await sr.json() : [] };
    }
    const since = parseInt(url.searchParams.get('since') || '', 10);
    if (since === room.version) return json({ unchanged: true, version: room.version, strokes });
    let results = [];
    if (room.status === 'ended') {
      const xr = await sb(`/rest/v1/game_results?room_id=eq.${id}&select=user_id,rank,score,user:profiles(nickname)&order=rank.asc.nullslast`);
      results = (xr.ok ? await xr.json() : []).map(x => ({ nickname: (x.user || {}).nickname || '', rank: x.rank, score: x.score == null ? null : Number(x.score), me: x.user_id === me }));
    }
    const active = all.filter(m => !m.left_at);
    const relay = room.game_key === 'draw_relay' && room.state && room.state.order ? await relayView(room, all) : null;
    const memory = room.game_key === 'memory_parts' && room.state && room.state.order ? await memoryView(room, all) : null;
    const sketch = room.game_key === 'sketch_quiz' && room.state && room.state.order ? await sketchView(room, all) : null;
    return json({
      id: room.id, version: room.version, status: room.status, code: room.status === 'waiting' ? room.join_code : null,
      game: room.game, max_players: room.max_players, state: relay || memory || sketch ? {} : (room.state || {}), relay, memory, sketch, strokes, expires_at: room.expires_at,
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
  // 게임별 DB 함수
  const FN = { draw_relay: { start: 'gd_start', submit: 'gd_submit', tick: 'gd_advance' }, memory_parts: { start: 'mp_start', submit: 'mp_submit', tick: 'mp_advance' },
    sketch_quiz: { start: 'qd_start', tick: 'qd_advance' } };
  const gameOf = async () => { const gr = await sb(`/rest/v1/game_rooms?id=eq.${room}&select=game_key`); return ((gr.ok ? await gr.json() : [])[0] || {}).game_key || null; };
  if (a === 'start') {
    const fn = FN[await gameOf()];
    if (fn && fn.start === 'qd_start') return out(await rpc(env, 'qd_start', { p_actor: me, p_room: room, p_laps: b.laps === 2 ? 2 : 1 }));
    return out(await rpc(env, fn ? fn.start : 'gm_start', { p_actor: me, p_room: room }));
  }
  if (a === 'pick' || a === 'stroke' || a === 'guess') {
    const turn = parseInt(b.turn, 10);
    if (!Number.isInteger(turn)) return fail('step_over');
    if (a === 'pick') return out(await rpc(env, 'qd_pick', { p_user: me, p_room: room, p_turn: turn, p_word: String(b.word || '').slice(0, 20) }));
    if (a === 'stroke') {
      const data = cleanStrokes(b.data);
      if (!data || !data.length) return fail('invalid_image');
      return out(await rpc(env, 'qd_stroke', { p_user: me, p_room: room, p_turn: turn, p_data: data }));
    }
    const text = String(b.text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
    if (!text) return fail('invalid_choice');
    if (hasBadWord(text)) return json({ error: '고운 말로 다시 써 주세요. 🙂', code: 'bad_word' }, 400);
    return out(await rpc(env, 'qd_guess', { p_user: me, p_room: room, p_turn: turn, p_text: text }));
  }
  if (a === 'submit') {
    const fn = FN[await gameOf()];
    if (!fn || !fn.submit) return fail('not_playing');
    const step = parseInt(b.round != null ? b.round : b.step, 10);
    if (!Number.isInteger(step)) return fail('step_over');
    const image = typeof b.image === 'string' ? b.image : null;
    const choice = typeof b.choice === 'string' ? b.choice.slice(0, 40) : null;
    if (image && image.length > 200000) return fail('invalid_image');
    const args = fn.submit === 'mp_submit' ? { p_user: me, p_room: room, p_round: step, p_image: image, p_choice: choice } : { p_user: me, p_room: room, p_step: step, p_image: image, p_choice: choice };
    return out(await rpc(env, fn.submit, args));
  }
  if (a === 'tick') {
    const fn = FN[await gameOf()];
    if (!fn) return json({ ok: true, advanced: false });
    const r = await rpc(env, fn.tick, { p_room: room });
    return json({ ok: true, advanced: !!(r.data && (r.data.step != null || r.data.round != null || r.data.phase || r.data.ended)) });
  }
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
