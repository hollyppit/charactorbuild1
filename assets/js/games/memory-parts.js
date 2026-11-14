// 기억 조각 그림 화면 (5단계 두 번째 게임). game-room.html 이 불러와 BoldGames.memory_parts 로 쓴다.
// 서버가 주는 d.memory: {phase:'show'|'draw'|'guess'|'result'|'reveal', round, rounds, K, role:'drawer'|'guesser'|'watch', guesser,
//   remaining_ms, my_part, submitted, done, need, character?(show·그리는 사람), parts?[{part,image,nickname,mine}], options?[{id,label,src}],
//   answer?, guess?, correct?}  끝나면 {phase:'reveal', K, kept, rounds:[{round, guesser, answer, guess, correct, parts}]}
// 3초마다 다시 그려지므로 같은 라운드·단계에서는 그림판을 새로 만들지 않는다.
(function () {
  const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const LABELS = { 1: ['전체'], 2: ['위쪽 (머리·얼굴)', '아래쪽 (몸·다리)'], 3: ['머리', '몸통·팔', '다리·발'], 4: ['머리', '어깨·팔', '배·손', '다리·발'] };
  const partName = (p, K) => (LABELS[K] || LABELS[4])[p] || '부위';
  const W = 480, H = 360;
  let S = null;

  function stop() { if (S) { clearInterval(S.timer); clearTimeout(S.hide); S = null; } }

  // 부위 그림들을 칸별로 잘라 한 장으로 합치기
  function compose(parts, K, width) {
    const cv = el('canvas', 'width:100%;max-width:' + (width || 400) + 'px;border:3px solid #000;background:#fff;display:block;margin:0 auto');
    cv.width = W; cv.height = H;
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    const bh = H / K;
    for (let k = 0; k < K; k++) { if (k) { x.strokeStyle = '#ddd'; x.setLineDash([6, 6]); x.beginPath(); x.moveTo(0, k * bh); x.lineTo(W, k * bh); x.stroke(); } }
    (parts || []).forEach(p => {
      if (!p.image) return;
      const im = new Image();
      im.onload = () => x.drawImage(im, 0, p.part * bh * im.naturalHeight / H, im.naturalWidth, bh * im.naturalHeight / H, 0, p.part * bh, W, bh);
      im.src = p.image;
    });
    return cv;
  }
  const charCard = (c, size, noLabel) => {
    const box = el('div', 'text-align:center');
    const im = el('img', 'width:' + (size || 110) + 'px;height:' + (size || 110) + 'px;object-fit:contain;background:#fff;border:2px solid #000;display:block;margin:0 auto'); im.src = c.src; im.alt = c.label;
    box.append(im); if (!noLabel && c.label) box.append(el('div', 'font-weight:800;margin-top:4px;max-width:' + Math.max(110, size || 110) + 'px;margin-left:auto;margin-right:auto', c.label));
    return box;
  };

  function render(pc, d, link) {
    const M = d.memory;
    if (!M || M.phase === 'reveal') { stop(); return false; }
    const key = d.id + ':' + M.round + ':' + M.phase;
    if (S && S.key === key && pc.contains(S.box)) { update(M); return true; }
    stop(); pc.innerHTML = '';
    const box = el('div', 'display:flex;flex-direction:column;gap:10px');
    S = { key, box, pad: null, endAt: Date.now() + M.remaining_ms, autoSent: false, submitted: M.submitted };
    const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap');
    const title = { show: '캐릭터 기억하기', draw: '부위 그리기', guess: '맞히기', result: '정답 공개' }[M.phase] || '';
    top.append(el('b', '', '🧩 기억 조각 그림 · ' + (M.round + 1) + '/' + M.rounds + '라운드 · ' + title));
    S.timerEl = el('b', 'font-size:1.3rem;color:var(--yellow)'); top.append(S.timerEl);
    box.append(top, el('div', 'font-size:.85rem;opacity:.85', '이번 라운드 맞히는 사람: ' + (M.guesser || '?') + (M.role === 'guesser' ? ' (나)' : '')));

    if (M.role === 'watch') box.append(el('p', '', '이번 게임은 구경하고 있어요.'));
    else if (M.phase === 'show') {
      if (M.role === 'drawer' && M.character) {
        const hint = el('div', 'text-align:center;font-weight:800', '👀 잘 기억하세요! 3초 뒤에 사라져요');
        const card = charCard(M.character, M.character.set ? 280 : 200, true);   // 이름은 안 보여 줌 (모양을 기억하는 게임)
        box.append(hint, card);
        S.hide = setTimeout(() => { card.style.visibility = 'hidden'; hint.textContent = '🧠 기억났나요? 곧 그리기 시작!'; }, Math.min(3000, Math.max(0, M.remaining_ms - 500)));
        box.append(el('div', 'text-align:center;font-size:.85rem;opacity:.85', '곧 맡을 부위: ' + partName(M.my_part, M.K)));
      } else box.append(el('div', 'text-align:center;padding:24px 0', '친구들이 캐릭터를 보고 있어요. 맞힐 준비! 🔍'));
    } else if (M.phase === 'draw') {
      if (M.role === 'drawer') {
        box.append(el('div', 'text-align:center;font-weight:800', '내가 그릴 부위: ' + partName(M.my_part, M.K) + ' — 분홍 점선 칸 안에만 그려요'));
        S.pad = DrawPad.create(box, { band: [M.my_part, M.K] });
        S.btn = el('button', ''); S.btn.type = 'button'; S.btn.className = 'btn btn-main';
        S.btn.onclick = () => send(link, M.round);
        box.append(S.btn);
      } else box.append(el('div', 'text-align:center;padding:24px 0', '친구들이 부위를 나눠 그리는 중이에요. 다 그리면 맞힐 차례! ✏️'));
    } else if (M.phase === 'guess') {
      box.append(compose(M.parts, M.K));
      if (M.role === 'guesser') {
        box.append(el('div', 'text-align:center;font-weight:800', '어떤 캐릭터일까요? 골라 주세요'));
        const opts = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px');
        (M.options || []).forEach(o => {
          const b = el('button', 'padding:8px;background:#fff;color:#111;border:3px solid #000;cursor:pointer'); b.type = 'button';
          b.append(charCard(o, o.set !== undefined ? 150 : 90));
          b.onclick = async () => {
            [...opts.children].forEach(x => { x.style.outline = x === b ? '4px solid var(--yellow,#ffd400)' : 'none'; x.disabled = true; });
            try { await link.send('submit', { round: M.round, choice: o.id }); } catch (e) { alert(e.message); [...opts.children].forEach(x => { x.disabled = false; }); }
          };
          opts.append(b);
        });
        box.append(opts);
      } else box.append(el('div', 'text-align:center', M.guesser + '님이 맞히는 중이에요...'));
    } else if (M.phase === 'result') {
      box.append(el('div', 'text-align:center;font-size:1.4rem;font-weight:900', M.correct ? '🎉 정답!' : '😅 아쉬워요!'));
      const row = el('div', 'display:flex;gap:12px;justify-content:center;flex-wrap:wrap;align-items:flex-start');
      const left = el('div', 'flex:1;min-width:200px;max-width:320px'); left.append(compose(M.parts, M.K, 320), el('div', 'text-align:center;font-size:.85rem', '친구들이 그린 그림'));
      const right = el('div', 'display:flex;gap:10px');
      const a = el('div'); a.append(el('div', 'text-align:center;font-size:.8rem', '정답'), charCard(M.answer, M.answer.set !== undefined ? 130 : 100)); right.append(a);
      if (M.guess && !M.correct) { const g = el('div'); g.append(el('div', 'text-align:center;font-size:.8rem', '고른 답'), charCard(M.guess, M.guess.set !== undefined ? 130 : 100)); right.append(g); }
      row.append(left, right); box.append(row);
      // 닮은꼴 세트: 어디가 달랐는지
      if (M.answer && M.answer.set !== undefined && M.guess && !M.correct) box.append(el('div', 'text-align:center;font-weight:800;margin-top:6px', '🔎 다른 점 — 정답: ' + (M.answer.label || '기본') + ' / 고른 그림: ' + (M.guess.label || '기본')));
    }
    S.statusEl = el('div', 'text-align:center;font-size:.9rem'); box.append(S.statusEl);
    pc.append(box);
    S.timer = setInterval(() => tick(link, M.round), 500);
    update(M); tick(link, M.round);
    return true;
  }

  function update(M) {
    if (!S) return;
    S.endAt = Date.now() + M.remaining_ms;
    S.submitted = M.submitted;
    if (S.btn) S.btn.textContent = M.submitted ? '✏️ 고쳐서 다시 내기' : '✅ 다 그렸어요 (내기)';
    if (M.phase === 'draw') S.statusEl.textContent = (M.role === 'drawer' && M.submitted ? '냈어요! 시간 안에는 다시 고쳐 낼 수 있어요. · ' : '') + M.done + '/' + M.need + '명 냈어요';
  }

  async function send(link, round) {
    if (!S || !S.pad) return;
    S.btn.disabled = true;
    try { await link.send('submit', { round, image: S.pad.toImage() }); }
    catch (e) { if (e.code !== 'step_over') alert(e.message); }
    if (S && S.btn) S.btn.disabled = false;
  }

  function tick(link, round) {
    if (!S) return;
    const left = Math.max(0, Math.ceil((S.endAt - Date.now()) / 1000));
    S.timerEl.textContent = '⏱ ' + left + '초';
    if (left > 0 || S.autoSent) return;
    S.autoSent = true;
    // 그리기 시간이 끝났는데 아직 안 냈으면 지금 그림을 내고, 서버에 다음 단계로 넘기기를 요청
    const p = S.pad && !S.submitted ? link.send('submit', { round, image: S.pad.toImage() }).catch(() => {}) : Promise.resolve();
    p.then(() => setTimeout(() => link.send('tick').catch(() => {}), 600));
  }

  // 끝난 뒤: 라운드마다 정답 캐릭터·합친 그림·고른 답
  function reveal(pc, d) {
    stop();
    const M = d.memory;
    if (!M || M.phase !== 'reveal') return;
    pc.append(el('h2', '', '🖼 라운드 다시 보기'));
    if (!M.kept) { pc.append(el('div', 'opacity:.8', '그림은 게임이 끝나고 1일 뒤 지워졌어요.')); }
    else pc.append(el('div', 'font-size:.85rem;opacity:.8;margin-bottom:8px', '그림은 1일 동안만 남아요. 내 부위 그림은 "내 기기에 저장"을 눌러 주세요.'));
    M.rounds.forEach(x => {
      const card = el('div', 'border-top:2px solid #3a2a3a;padding:12px 0');
      card.append(el('div', 'font-weight:800;margin-bottom:6px', (x.round + 1) + '라운드 · 맞히는 사람 ' + x.guesser + ' · ' + (x.correct ? '✅ 정답' : '❌ 아쉬워요')));
      const row = el('div', 'display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start');
      if (M.kept) { const l = el('div', 'flex:1;min-width:180px;max-width:280px'); l.append(compose(x.parts, M.K, 280)); row.append(l); }
      const a = el('div'); a.append(el('div', 'text-align:center;font-size:.8rem', '정답'), charCard(x.answer, 80)); row.append(a);
      if (x.guess && !x.correct) { const g = el('div'); g.append(el('div', 'text-align:center;font-size:.8rem', '고른 답'), charCard(x.guess, 80)); row.append(g); }
      card.append(row);
      const who = el('div', 'font-size:.8rem;opacity:.85;margin-top:6px');
      who.textContent = '그린 친구: ' + (x.parts.map(p => partName(p.part, M.K) + ' ' + p.nickname + (p.mine ? '(나)' : '')).join(' · ') || '없음');
      card.append(who);
      x.parts.filter(p => p.mine && p.image).forEach(p => { const dl = el('a', 'font-size:.75rem;margin-right:8px', '내 그림 저장'); dl.href = p.image; dl.download = '기억조각-' + (x.round + 1) + '라운드.' + (p.image.startsWith('data:image/png') ? 'png' : p.image.startsWith('data:image/jpeg') ? 'jpg' : 'webp'); card.append(dl); });
      pc.append(card);
    });
  }

  window.BoldGames = window.BoldGames || {};
  window.BoldGames.memory_parts = { render, reveal, stop };
})();
