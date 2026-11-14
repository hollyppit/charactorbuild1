// 관리자: 게임 제시어·게임 공개 상태 관리 (X-Admin-Hash 필요)
//  GET  /api/admin/games                        제시어 전체·분류·게임 목록·기억 조각 그림 캐릭터 수
//  POST /api/admin/games {action, ...}
//    add_words {words:"낱말, 낱말\n낱말", category, games:[...]}   여러 개 한 번에 (이미 있는 낱말은 건너뜀)
//    update_word {id, word?, category?, active?, games?}
//    delete_word {id}
//    game_status {key, status:'off'|'beta'|'on'}
// 게임마다 필요한 최소 낱말 수를 지키도록 바꾸기 전에 확인한다 (그림 릴레이 11개, 쓱싹 퀴즈 19개, 숨은 라이어 그림: 낱말 5개 이상인 분류 1개 이상·그 분류 낱말 합 8개 이상).
import { corsHeaders, jsonResponder, checkOrigin, checkSize, isAdmin, makeSb } from '../_lib/common.js';
import { hasBadWord } from '../_lib/words.js';

const WORD_GAMES = ['draw_relay', 'sketch_quiz', 'liar_draw'];
const NAMES = { draw_relay: '그림 릴레이', sketch_quiz: '쓱싹 퀴즈', liar_draw: '숨은 라이어 그림' };
const STATUSES = ['off', 'beta', 'on'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').trim().slice(0, n);

// 바꾼 뒤의 낱말 목록으로 게임마다 쓸 수 있는지 확인 → 문제 있으면 안내 문장
function shortage(words) {
  const use = k => words.filter(w => w.active && (w.games || []).includes(k));
  const msgs = [];
  if (use('draw_relay').length < 11) msgs.push(NAMES.draw_relay + '에는 낱말이 11개 이상 필요해요');
  if (use('sketch_quiz').length < 19) msgs.push(NAMES.sketch_quiz + '에는 낱말이 19개 이상 필요해요');
  const byCat = {};
  use('liar_draw').forEach(w => { byCat[w.category] = (byCat[w.category] || 0) + 1; });
  const ok = Object.values(byCat).filter(n => n >= 5);
  if (!ok.length || ok.reduce((a, b) => a + b, 0) < 8) msgs.push(NAMES.liar_draw + '에는 낱말이 5개 이상인 분류가 있어야 해요(그 분류 낱말 합 8개 이상)');
  return msgs;
}

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 64 * 1024, cors);
  if (bad) return bad;
  if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const sb = makeSb(env);
  const allWords = async () => { const r = await sb('/rest/v1/game_words?select=id,word,category,active,games&order=category.asc,word.asc&limit=2000'); return r.ok ? await r.json() : null; };

  if (request.method === 'GET') {
    const [words, gr, cr] = await Promise.all([
      allWords(),
      sb('/rest/v1/games?select=key,title,status,min_players,max_players&order=sort.asc'),
      sb('/rest/v1/char_items?category=eq.character&select=id'),
    ]);
    if (!words) return json({ error: 'DB(0021)가 아직 적용되지 않았어요.', code: 'not_ready' }, 503);
    return json({ words, games: gr.ok ? await gr.json() : [], word_games: WORD_GAMES.map(k => ({ key: k, title: NAMES[k] })),
      categories: [...new Set(words.map(w => w.category).filter(Boolean))], characters: cr.ok ? (await cr.json()).length : 0, warnings: shortage(words) });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const a = String(b.action || '');
  const gamesOf = v => { const g = (Array.isArray(v) ? v : []).filter(x => WORD_GAMES.includes(x)); return [...new Set(g)]; };

  if (a === 'game_status') {
    const key = String(b.key || '');
    if (!/^[a-z0-9_]{2,30}$/.test(key) || !STATUSES.includes(b.status)) return json({ error: '잘못된 값이에요.' }, 400);
    const r = await sb(`/rest/v1/games?key=eq.${key}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: b.status }) });
    const rows = r.ok ? await r.json() : [];
    return rows.length ? json({ ok: true }) : json({ error: '게임을 찾을 수 없어요.' }, 404);
  }

  const words = await allWords();
  if (!words) return json({ error: 'DB(0021)가 아직 적용되지 않았어요.', code: 'not_ready' }, 503);

  if (a === 'add_words') {
    const category = clean(b.category, 12);
    if (!category) return json({ error: '분류를 정해 주세요.' }, 400);
    const games = gamesOf(b.games);
    if (!games.length) return json({ error: '쓸 게임을 하나 이상 골라 주세요.' }, 400);
    const list = [...new Set(String(b.words || '').split(/[,\n]/).map(x => clean(x, 20)).filter(Boolean))].slice(0, 200);
    if (!list.length) return json({ error: '추가할 낱말을 적어 주세요.' }, 400);
    const badOnes = list.filter(hasBadWord);
    if (badOnes.length) return json({ error: '쓸 수 없는 낱말이 있어요: ' + badOnes.join(', ') }, 400);
    const exists = new Set(words.map(w => w.word));
    const fresh = list.filter(w => !exists.has(w));
    if (fresh.length) {
      const r = await sb('/rest/v1/game_words', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(fresh.map(word => ({ word, category, games, active: true }))) });
      if (!r.ok) return json({ error: '추가하지 못했어요.' }, 500);
    }
    return json({ ok: true, added: fresh.length, skipped: list.filter(w => exists.has(w)) });
  }

  const id = parseInt(b.id, 10);
  const target = words.find(w => w.id === id);
  if (!target) return json({ error: '낱말을 찾을 수 없어요.' }, 404);

  if (a === 'update_word') {
    const patch = {};
    if ('word' in b) {
      const w = clean(b.word, 20);
      if (!w) return json({ error: '낱말을 적어 주세요.' }, 400);
      if (hasBadWord(w)) return json({ error: '쓸 수 없는 낱말이에요.' }, 400);
      if (words.some(x => x.word === w && x.id !== id)) return json({ error: '이미 있는 낱말이에요.' }, 409);
      patch.word = w;
    }
    if ('category' in b) { const c = clean(b.category, 12); if (!c) return json({ error: '분류를 적어 주세요.' }, 400); patch.category = c; }
    if ('active' in b) patch.active = !!b.active;
    if ('games' in b) patch.games = gamesOf(b.games);
    if (!Object.keys(patch).length) return json({ error: '바꿀 내용이 없어요.' }, 400);
    const after = words.map(w => w.id === id ? { ...w, ...patch } : w);
    const warn = shortage(after);
    if (warn.length && warn.length > shortage(words).length) return json({ error: '이렇게 바꾸면 낱말이 모자라요: ' + warn.join(' / ') }, 400);
    const r = await sb(`/rest/v1/game_words?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    return r.ok ? json({ ok: true }) : json({ error: '바꾸지 못했어요.' }, 500);
  }

  if (a === 'delete_word') {
    const warn = shortage(words.filter(w => w.id !== id));
    if (warn.length && warn.length > shortage(words).length) return json({ error: '지우면 낱말이 모자라요: ' + warn.join(' / ') }, 400);
    const r = await sb(`/rest/v1/game_words?id=eq.${id}`, { method: 'DELETE' });
    return r.ok ? json({ ok: true }) : json({ error: '지우지 못했어요.' }, 500);
  }

  return json({ error: 'unknown_action' }, 400);
}
