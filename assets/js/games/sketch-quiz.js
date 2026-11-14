// 쓱싹 퀴즈 화면 (5단계 세 번째 게임). game-room.html 이 불러와 BoldGames.sketch_quiz 로 쓴다.
// 서버가 주는 d.sketch: {phase:'pick'|'draw'|'turn_end'|'reveal', turn, turns, laps, drawer, role:'drawer'|'guesser'|'watch', remaining_ms,
//   hits:[{nickname, points, me}], my_hit, choices?(pick·그리는 사람), word?(그리는 사람·맞힌 사람·차례 끝), hint?, hint_first?}
//   끝나면 {phase:'reveal', turns:[{turn, drawer, mine, word, hits}]}
// 그리는 모습: 그리는 사람이 0.7초마다 새 획 조각을 보내고, 다른 사람은 1초마다 물어볼 때(sk=마지막 획) 받은 조각을 다시 그린다.
// 진행 중에는 방 연결의 물어보는 간격을 1초로, 끝나면 3초로 되돌린다.
(function () {
  const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  let S = null;   // 이번 차례 화면 상태
  const SK = { turn: -1, id: 0 };   // 마지막으로 받은 획
  let hooked = null;

  function stop() {
    if (S) { clearInterval(S.timer); clearInterval(S.sendTimer); S = null; }
    if (hooked) { hooked.setPollMs(3000); hooked.setExtra(null); }
  }

  // 방 연결에 1초 간격·획 받기를 건다 (한 번만)
  function hook(link) {
    link.setPollMs(1000);
    link.setExtra(() => '&sk=' + (SK.id || 0));
    if (hooked === link) return;
    hooked = link;
    link.listen(d => {
      if (!d || !d.strokes || !S || !S.viewer) return;
      if (d.strokes.turn !== S.turn) return;
      if (SK.turn !== d.strokes.turn) { SK.turn = d.strokes.turn; SK.id = 0; }
      const items = d.strokes.items || [];
      if (!items.length) return;
      SK.id = items[items.length - 1].id;
      S.viewer.apply(items.flatMap(x => x.data || []));
    });
  }

  function render(pc, d, link) {
    const Q = d.sketch;
    if (!Q || Q.phase === 'reveal') { stop(); return false; }
    hook(link);
    if (SK.turn !== Q.turn) { SK.turn = Q.turn; SK.id = 0; }
    if (!(S && S.turn === Q.turn && S.room === d.id && pc.contains(S.box))) build(pc, d, link);
    if (S.phase !== Q.phase) phase(Q, link);
    update(Q);
    return true;
  }

  function build(pc, d, link) {
    if (S) { clearInterval(S.timer); clearInterval(S.sendTimer); }
    pc.innerHTML = '';
    const Q = d.sketch;
    const box = el('div', 'display:flex;flex-direction:column;gap:10px');
    S = { room: d.id, turn: Q.turn, phase: null, box, link, role: Q.role, endAt: Date.now() + Q.remaining_ms, autoTick: false };
    const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap');
    S.titleEl = el('b'); S.timerEl = el('b', 'font-size:1.3rem;color:var(--yellow)');
    top.append(S.titleEl, S.timerEl);
    S.wordEl = el('div', 'text-align:center;font-size:1.6rem;font-weight:900;letter-spacing:.15em;color:var(--yellow);min-height:1.2em');
    S.subEl = el('div', 'text-align:center;font-size:.9rem');
    S.main = el('div');
    S.side = el('div', 'display:flex;flex-direction:column;gap:6px');
    S.hitsEl = el('div', 'font-size:.9rem');
    box.append(top, S.wordEl, S.subEl, S.main, S.side, S.hitsEl);
    pc.append(box);
    S.timer = setInterval(() => tick(), 500);
  }

  // 단계가 바뀔 때 가운데(그림판/보기)와 아래(고르기·입력) 다시 꾸미기
  function phase(Q, link) {
    const prev = S.phase; S.phase = Q.phase;
    S.autoTick = false;
    S.side.innerHTML = '';
    if (Q.phase === 'pick') {
      S.main.innerHTML = '';
      if (Q.role === 'drawer') {
        S.side.append(el('div', 'text-align:center;font-weight:800', '그릴 제시어를 골라요! (10초 안에 안 고르면 첫 번째로)'));
        const row = el('div', 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px');
        (Q.choices || []).forEach(w => {
          const b = el('button', 'padding:16px 6px;font-size:1.15rem;font-weight:900', w); b.type = 'button'; b.className = 'btn btn-main';
          b.onclick = async () => { [...row.children].forEach(x => { x.disabled = true; }); try { await link.send('pick', { turn: Q.turn, word: w }); } catch (e) { alert(e.message); [...row.children].forEach(x => { x.disabled = false; }); } };
          row.append(b);
        });
        S.side.append(row);
      } else S.main.append(el('div', 'text-align:center;padding:30px 0', '✏️ ' + Q.drawer + '님이 그릴 제시어를 고르는 중이에요...'));
      return;
    }
    if (Q.phase === 'draw') {
      if (prev !== 'draw') {
        S.main.innerHTML = '';
        if (Q.role === 'drawer') {
          S.main.append(el('div', 'text-align:center;font-size:.85rem;opacity:.85;margin-bottom:6px', '글자는 쓰지 말고 그림으로만 그려요!'));
          S.pad = DrawPad.create(S.main);
          S.sending = false;
          S.sendTimer = setInterval(() => flush(Q.turn), 700);
        } else {
          S.viewer = DrawPad.viewer(S.main);
          SK.turn = Q.turn; SK.id = 0;   // 처음부터 다시 받기
          link.refresh();
        }
      }
      if (Q.role === 'guesser') guessBox(Q, link);
      return;
    }
    if (Q.phase === 'turn_end') {
      if (S.pad) { flush(Q.turn); clearInterval(S.sendTimer); const bar = S.pad.el.lastChild; if (bar) bar.style.display = 'none'; S.pad.el.style.pointerEvents = 'none'; }
    }
  }

  // 정답 입력 (틀린 답은 내 화면에만)
  function guessBox(Q, link) {
    S.side.innerHTML = '';
    if (Q.my_hit) { S.side.append(el('div', 'text-align:center;font-weight:900;color:var(--green,#3c3)', '🎉 정답! +' + Q.my_hit + '점 — 다른 친구들을 기다려요')); return; }
    const row = el('div', 'display:flex;gap:6px');
    const inp = el('input', 'flex:1;font-size:1.1rem;padding:10px'); inp.type = 'text'; inp.maxLength = 20; inp.placeholder = '정답을 써 보세요'; inp.autocomplete = 'off';
    const go = el('button', 'padding:10px 16px', '확인'); go.type = 'button'; go.className = 'btn btn-main'; go.style.width = 'auto'; go.style.margin = '0';
    const fb = el('div', 'font-size:.9rem;min-height:1.3em;text-align:center');
    let busy = false, lastAt = 0;
    const send = async () => {
      const v = inp.value.trim(); if (!v || busy) return;
      const wait = 1500 - (Date.now() - lastAt); if (wait > 0) { fb.textContent = '조금 천천히! ⏳'; return; }
      busy = true; lastAt = Date.now();
      try {
        const r = await SocialUI.api('/api/game-rooms', { method: 'POST', body: JSON.stringify({ action: 'guess', room_id: S.room, turn: Q.turn, text: v }) });
        if (r.correct) { fb.textContent = ''; link.refresh(); }
        else { fb.style.color = ''; fb.textContent = (r.close ? '🔥 거의 맞았어요! ' : '❌ ') + '"' + v + '" 은(는) 아니에요'; inp.value = ''; inp.focus(); }
      } catch (e) { fb.textContent = e.message; }
      busy = false;
    };
    go.onclick = send;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
    row.append(inp, go);
    S.side.append(row, fb, el('div', 'font-size:.75rem;opacity:.7;text-align:center', '틀린 답은 나에게만 보여요.'));
  }

  // 그리는 사람: 새 획 조각을 차례대로 보내기 (앞의 것이 끝나야 다음)
  async function flush(turn) {
    if (!S || !S.pad || S.sending) return;
    const items = S.pad.takeNew();
    if (!items.length) return;
    S.sending = true;
    for (let i = 0; i < items.length; i += 50) {
      try { await SocialUI.api('/api/game-rooms', { method: 'POST', body: JSON.stringify({ action: 'stroke', room_id: S.room, turn, data: items.slice(i, i + 50) }) }); }
      catch (e) { if (e.code === 'step_over') break; }
    }
    if (S) S.sending = false;
  }

  function update(Q) {
    if (!S) return;
    S.endAt = Date.now() + Q.remaining_ms;
    const ph = { pick: '제시어 고르기', draw: '그리기', turn_end: '정답 공개' }[Q.phase] || '';
    S.titleEl.textContent = '✏️ 쓱싹 퀴즈 · ' + (Q.turn + 1) + '/' + Q.turns + '차례 · ' + ph;
    S.subEl.textContent = Q.role === 'drawer' ? (Q.phase === 'draw' ? '내가 그리는 차례예요!' : '') : '그리는 친구: ' + Q.drawer;
    if (Q.phase === 'draw') S.wordEl.textContent = Q.word ? (Q.role === 'drawer' ? '제시어: ' + Q.word : '정답: ' + Q.word) : (Q.hint || '') + (Q.hint && !Q.hint_first ? '  (' + [...Q.hint.replace(/ /g, '')].length + '글자)' : '');
    else if (Q.phase === 'turn_end') S.wordEl.textContent = '정답: ' + (Q.word || '?');
    else S.wordEl.textContent = '';
    if (Q.phase === 'draw' && Q.role === 'guesser' && Q.my_hit && !S.side.textContent.includes('정답!')) guessBox(Q, S.link);
    S.hitsEl.textContent = Q.hits.length ? '맞힌 친구: ' + Q.hits.map(h => h.nickname + (h.me ? '(나)' : '') + ' +' + h.points).join(' · ') : (Q.phase === 'draw' ? '아직 맞힌 친구가 없어요' : '');
  }

  function tick() {
    if (!S) return;
    const left = Math.max(0, Math.ceil((S.endAt - Date.now()) / 1000));
    S.timerEl.textContent = '⏱ ' + left + '초';
    if (left > 0 || S.autoTick) return;
    S.autoTick = true;
    const p = S.pad && S.phase === 'draw' ? flush(S.turn) : Promise.resolve();
    Promise.resolve(p).then(() => setTimeout(() => S && S.link.send('tick').catch(() => {}), 500));
  }

  // 끝난 뒤: 차례마다 그림 다시 보기 (획을 차례별로 받아 바로 그림)
  function reveal(pc, d) {
    stop();
    const Q = d.sketch;
    if (!Q || Q.phase !== 'reveal') return;
    pc.append(el('h2', '', '🖼 그림 다시 보기'));
    pc.append(el('div', 'font-size:.85rem;opacity:.8;margin-bottom:8px', '그림은 1일 동안만 남아요. 내 그림은 "내 기기에 저장"을 눌러 주세요.'));
    const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px');
    pc.append(grid);
    (async () => {
      for (const t of Q.turns) {
        const card = el('div', 'border:2px solid #3a2a3a;padding:8px');
        card.append(el('div', 'font-weight:800;margin-bottom:4px', (t.turn + 1) + '. "' + t.word + '" · ' + t.drawer + (t.mine ? ' (나)' : '')));
        const v = DrawPad.viewer(card, { instant: true, max: 260 });
        card.append(el('div', 'font-size:.8rem;margin-top:4px', t.hits.length ? '맞힌 친구: ' + t.hits.map(h => h.nickname + ' +' + h.points).join(', ') : '아무도 못 맞혔어요'));
        grid.append(card);
        try {
          const r = await SocialUI.api('/api/game-rooms?id=' + encodeURIComponent(d.id) + '&strokes_turn=' + t.turn);
          if (!r.strokes.length) { card.insertBefore(el('div', 'font-size:.8rem;opacity:.7', '그림이 지워졌거나 없어요.'), v.el.nextSibling); continue; }
          v.apply(r.strokes.flatMap(x => x.data || []));
          if (t.mine) { const a = el('a', 'font-size:.75rem', '내 기기에 저장'); a.href = '#'; a.onclick = e => { e.preventDefault(); const l = document.createElement('a'); l.href = v.toImage(); l.download = '쓱싹퀴즈-' + t.word + '.png'; l.click(); }; card.append(a); }
        } catch (e) {}
      }
    })();
  }

  window.BoldGames = window.BoldGames || {};
  window.BoldGames.sketch_quiz = { render, reveal, stop };
})();
