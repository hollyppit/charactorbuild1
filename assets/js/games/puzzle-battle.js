// 그림 퍼즐 배틀 화면. game-room.html 이 불러와 BoldGames.jigsaw 로 쓴다 (퍼즐 엔진 jigsaw.js 필요).
// 서버가 주는 d.puzzle: {phase:'play'|'ended', title, image, level, seed, role, remaining_ms, limit_sec, players[{nickname, me, placed, total, finished, ms}]}
// 모두 같은 그림·seed 로 시작. 각자 직소(끌기)·사각 조각(누르기) 중 편한 방식으로 하고, 맞춘 조각 수를 서버에 알린다.
(function () {
  const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const fmt = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  let S = null;

  // 게임 중에는 방 화면을 넓게 (넓은 화면에서 판 왼쪽·조각 오른쪽)
  const wide = on => { const r = document.getElementById('root'); if (r) r.style.maxWidth = on ? '1400px' : ''; };
  function stop() { wide(false); if (S) { clearInterval(S.timer); clearTimeout(S.sendT); S = null; } }

  async function startBoard(P) {
    S.stage.textContent = '조각 만드는 중...';
    S.placed = 0; S.total = 0;
    try {
      S.game = await Jigsaw.start(S.stage, { image: P.image, level: P.level, seed: P.seed, mode: S.mode,
        onProgress: (n, t) => { S.placed = n; S.total = t; queue(); },
        onComplete: () => { S.done = true; queue(true); } });
      S.total = S.game.total; queue();
    } catch (e) { S.stage.textContent = e.message; return; }
    const pv = () => { const n = S.game.previewsLeft(); S.pvBtn.textContent = '👀 원래 그림' + (n === Infinity ? '' : ' (' + n + ')'); S.pvBtn.disabled = n <= 0; };
    pv(); S.pvBtn.onclick = () => { S.game.preview(); pv(); };
    S.edgeBtn.style.display = S.game.mode === 'jigsaw' && S.game.level.edges ? '' : 'none';
    S.edgeBtn.onclick = () => { S.edgeBtn.classList.toggle('on', !!S.game.toggleEdges()); };
  }

  // 진행 보내기: 1.5초에 한 번 모아서, 완성은 바로
  function queue(now) {
    if (!S) return;
    clearTimeout(S.sendT);
    const send = async () => {
      if (!S || !S.total) return;
      try { await SocialUI.api('/api/game-rooms', { method: 'POST', body: JSON.stringify({ action: 'report', room_id: S.room, placed: S.placed, total: S.total }) }); if (now) S.link.refresh(); }
      catch (e) { if (e.code === 'too_fast') S.msg.textContent = '너무 빨라서 기록되지 않았어요. 조금 뒤 다시 확인할게요.'; }
    };
    if (now) send(); else S.sendT = setTimeout(send, 1500);
  }

  function render(pc, d, link) {
    const P = d.puzzle;
    if (!P || P.phase !== 'play') { stop(); return false; }
    if (!(S && S.room === d.id && pc.contains(S.box))) {
      stop(); pc.innerHTML = '';
      const box = el('div', 'display:flex;flex-direction:column;gap:8px');
      S = { room: d.id, box, link, endAt: Date.now() + P.remaining_ms, mode: Jigsaw.prefersTiles() ? 'tiles' : 'jigsaw', ticked: false };
      const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap');
      top.append(el('b', '', '🧩 ' + P.title + ' · ' + ((Jigsaw.LEVELS[P.level] || {}).name || '')));
      S.timerEl = el('b', 'font-size:1.3rem;color:var(--yellow)'); top.append(S.timerEl);
      const tools = el('div', 'display:flex;flex-wrap:wrap;gap:6px');
      S.pvBtn = el('button'); S.pvBtn.type = 'button'; S.pvBtn.className = 'chip';
      S.edgeBtn = el('button', '', '가장자리 조각만'); S.edgeBtn.type = 'button'; S.edgeBtn.className = 'chip';
      const modeBtn = el('button', '', ''); modeBtn.type = 'button'; modeBtn.className = 'chip';
      const setModeLabel = () => { modeBtn.textContent = S.mode === 'tiles' ? '🧩 직소로 바꾸기' : '🔲 사각 조각으로 바꾸기'; };
      setModeLabel();
      modeBtn.onclick = () => { if (S.done) return; if (S.placed && !confirm('방식을 바꾸면 처음부터 다시 맞춰요. 바꿀까요?')) return; S.mode = S.mode === 'tiles' ? 'jigsaw' : 'tiles'; setModeLabel(); startBoard(P); };
      tools.append(S.pvBtn, S.edgeBtn, modeBtn);
      S.msg = el('div', 'font-size:.85rem;color:#ff6b6b');
      S.players = el('div', 'display:flex;flex-direction:column;gap:4px;font-size:.85rem');
      S.stage = el('div', 'width:100%');
      box.append(top, S.players, tools, S.msg, S.stage);
      pc.append(box);
      S.timer = setInterval(tick, 500);
      if (P.role === 'player') { wide(true); startBoard(P); } else S.stage.textContent = '이번 게임은 구경하고 있어요.';
    }
    S.endAt = Date.now() + P.remaining_ms;
    // 친구들 진행 막대
    S.players.innerHTML = '';
    P.players.forEach(p => {
      const pct = p.total ? Math.round(100 * p.placed / p.total) : 0;
      const row = el('div', 'display:flex;align-items:center;gap:6px');
      row.append(el('span', 'width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' + (p.me ? ';color:var(--yellow);font-weight:800' : ''), p.nickname + (p.me ? '(나)' : '')));
      const bar = el('div', 'flex:1;height:10px;background:#2d0040;border:1px solid #555');
      bar.append(el('div', 'height:100%;width:' + pct + '%;background:' + (p.finished ? '#3c3' : '#ff4fa3')));
      row.append(bar, el('span', 'width:70px;text-align:right', p.finished ? '✅ ' + fmt(p.ms) : pct + '%'));
      S.players.append(row);
    });
    return true;
  }

  function tick() {
    if (!S) return;
    const left = Math.max(0, Math.ceil((S.endAt - Date.now()) / 1000));
    S.timerEl.textContent = '⏱ ' + fmt(left * 1000);
    if (left > 0 || S.ticked) return;
    S.ticked = true;
    const link = S.link; queue(true); setTimeout(() => link.send('tick').catch(() => {}), 800);
  }

  // 끝난 뒤: 완성 그림과 기록
  function reveal(pc, d) {
    stop();
    const P = d.puzzle; if (!P) return;
    pc.append(el('h2', '', '🖼 ' + P.title));
    const im = el('img', 'width:100%;max-width:520px;display:block;margin:0 auto 8px;border:3px solid #000;background:#fff'); im.src = P.image; im.alt = ''; pc.append(im);
    P.players.forEach((p, i) => pc.append(el('div', 'font-size:.9rem' + (p.me ? ';color:var(--yellow);font-weight:800' : ''), (i + 1) + '. ' + p.nickname + (p.me ? ' (나)' : '') + ' — ' + (p.finished ? '완성 ' + fmt(p.ms) : (p.total ? Math.round(100 * p.placed / p.total) : 0) + '% 맞춤'))));
  }

  window.BoldGames = window.BoldGames || {};
  window.BoldGames.jigsaw = { render, reveal, stop };
})();
