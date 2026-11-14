// 이미지 상식 퀴즈 배틀 화면. game-room.html 이 불러와 BoldGames.quiz_battle 로 쓴다.
// 서버가 주는 d.quiz: {phase:'question'|'reveal'|'ended', q, total, role, remaining_ms, question, image, options, my_choice, done, need,
//   (정답 공개 때) correct, answers[{nickname, me, choice, correct, points}], my_points, totals[{nickname, me, score}]}
// 모두 같은 문제를 동시에 풀도록 진행 중에는 1초마다 새로 물어본다(끝나면 3초).
(function () {
  const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  let S = null, hooked = null;

  function stop() {
    if (S) { clearInterval(S.timer); S = null; }
    if (hooked) { hooked.setPollMs(3000); hooked = null; }
  }

  function render(pc, d, link) {
    const Q = d.quiz;
    if (!Q || Q.phase === 'ended') { stop(); return false; }
    link.setPollMs(1000); hooked = link;
    const key = d.id + ':' + Q.q + ':' + Q.phase + ':' + (Q.my_choice == null ? '' : Q.my_choice);
    if (S && S.key === key && pc.contains(S.box)) { update(Q); return true; }
    if (S) clearInterval(S.timer);
    pc.innerHTML = '';
    const box = el('div', 'display:flex;flex-direction:column;gap:10px');
    S = { key, box, link, q: Q.q, phase: Q.phase, endAt: Date.now() + Q.remaining_ms, ticked: false };
    const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap');
    top.append(el('b', '', '🧠 퀴즈 배틀 · ' + (Q.q + 1) + '/' + Q.total + '번 문제' + (Q.phase === 'reveal' ? ' · 정답 공개' : '')));
    S.timerEl = el('b', 'font-size:1.3rem;color:var(--yellow)'); top.append(S.timerEl);
    box.append(top);
    if (Q.image) { const im = el('img', 'width:100%;max-width:420px;max-height:300px;object-fit:contain;display:block;margin:0 auto;background:#fff;border:3px solid #000'); im.src = Q.image; im.alt = '문제 그림'; box.append(im); }
    box.append(el('div', 'text-align:center;font-size:1.15rem;font-weight:800', Q.question));
    const opts = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px');
    Q.options.forEach((o, i) => {
      const b = el('button', 'padding:14px 8px;font-size:1.05rem;font-weight:800', o); b.type = 'button';
      let cls = 'btn btn-sub';
      if (Q.phase === 'reveal') {
        if (i === Q.correct) { cls = 'btn btn-main'; b.textContent = '✅ ' + o; }
        else if (i === Q.my_choice) b.textContent = '❌ ' + o;
        b.disabled = true;
      } else if (Q.my_choice != null) { if (i === Q.my_choice) cls = 'btn btn-main'; b.disabled = true; }
      else if (Q.role === 'player') b.onclick = async () => { [...opts.children].forEach(x => { x.disabled = true; }); try { await link.send('answer', { q: Q.q, choice: i }); } catch (e) { alert(e.message); [...opts.children].forEach(x => { x.disabled = false; }); } };
      else b.disabled = true;
      b.className = cls;
      opts.append(b);
    });
    box.append(opts);
    if (Q.phase === 'reveal') {
      box.append(el('div', 'text-align:center;font-size:1.2rem;font-weight:900', Q.my_choice == null ? '⏰ 시간 안에 못 골랐어요' : Q.my_points ? '🎉 정답! +' + Q.my_points + '점' : '😅 아쉬워요!'));
      const hit = Q.answers.filter(a => a.correct);
      box.append(el('div', 'text-align:center;font-size:.9rem', hit.length ? '맞힌 친구: ' + hit.map(a => a.nickname + (a.me ? '(나)' : '') + ' +' + a.points).join(' · ') : '아무도 못 맞혔어요'));
      const rank = el('div', 'border-top:2px solid #3a2a3a;padding-top:8px');
      rank.append(el('div', 'font-weight:800;margin-bottom:4px', '지금 순위'));
      Q.totals.forEach((t, i) => rank.append(el('div', 'font-size:.9rem' + (t.me ? ';color:var(--yellow);font-weight:800' : ''), (i + 1) + '. ' + t.nickname + (t.me ? ' (나)' : '') + ' — ' + t.score + '점')));
      box.append(rank);
    }
    S.statusEl = el('div', 'text-align:center;font-size:.9rem'); box.append(S.statusEl);
    pc.append(box);
    S.timer = setInterval(tick, 300);
    update(Q); tick();
    return true;
  }

  function update(Q) {
    if (!S) return;
    S.endAt = Date.now() + Q.remaining_ms;
    if (Q.phase === 'question') S.statusEl.textContent = (Q.my_choice != null ? '골랐어요! 다른 친구들을 기다려요 · ' : '빨리 맞힐수록 점수가 높아요! · ') + Q.done + '/' + Q.need + '명 답했어요';
    else S.statusEl.textContent = '곧 다음 문제!';
  }

  function tick() {
    if (!S) return;
    const left = Math.max(0, Math.ceil((S.endAt - Date.now()) / 1000));
    S.timerEl.textContent = '⏱ ' + left + '초';
    if (left > 0 || S.ticked) return;
    S.ticked = true;
    const link = S.link; setTimeout(() => link.send('tick').catch(() => {}), 300);
  }

  window.BoldGames = window.BoldGames || {};
  window.BoldGames.quiz_battle = { render, stop };
})();
