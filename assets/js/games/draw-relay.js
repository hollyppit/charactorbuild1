// 그림 릴레이 화면 (5단계 첫 게임). game-room.html 이 불러와 BoldGames.draw_relay 로 쓴다.
// 서버가 주는 d.relay: 진행 중 {phase:'play', step, steps, kind:'draw'|'guess', remaining_ms, playing, submitted, done, need, word, prev_image, options}
//                     끝 {phase:'reveal', kept, chains:[{word, starter, correct, items:[{step, nickname, mine, kind, image, choice}]}]}
// 3초마다 다시 그려지므로, 같은 단계에서는 그림판을 새로 만들지 않고 진행 상황 글자만 바꾼다.
(function () {
  const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  let S = null;   // { key, box, pad, endAt, timer, statusEl, timerEl, submitBtn, picked, autoSent }

  function stop() { if (S) { clearInterval(S.timer); S = null; } }

  function render(pc, d, link) {
    const R = d.relay;
    if (!R || R.phase !== 'play') { stop(); return false; }
    const key = d.id + ':' + R.step;
    if (S && S.key === key && pc.contains(S.box)) { update(R); return true; }
    stop(); pc.innerHTML = '';
    const box = el('div', 'display:flex;flex-direction:column;gap:10px');
    S = { key, box, pad: null, endAt: Date.now() + R.remaining_ms, picked: null, autoSent: false };
    box.append(el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap'));
    const top = box.firstChild;
    top.append(el('b', '', '🎨 그림 릴레이 · ' + (R.step + 1) + '/' + R.steps + '단계 · ' + (R.kind === 'draw' ? '그리기' : '맞히기')));
    S.timerEl = el('b', 'font-size:1.3rem;color:var(--yellow)'); top.append(S.timerEl);

    if (!R.playing) {
      box.append(el('p', '', '이번 게임은 구경하고 있어요. 끝나면 결과를 볼 수 있어요.'));
    } else if (R.kind === 'draw') {
      if (R.step === 0) {
        box.append(el('div', 'text-align:center', '제시어'), el('div', 'text-align:center;font-size:2rem;font-weight:900;color:var(--yellow)', R.word || '?'),
          el('div', 'text-align:center;font-size:.85rem;opacity:.8', '글자는 쓰지 말고 그림으로만 그려요!'));
      } else {
        box.append(el('div', 'text-align:center', '앞 친구의 그림을 보고, 똑같이 그려 보세요 (무엇인지 몰라도 괜찮아요)'));
        if (R.prev_image) { const im = el('img', 'width:100%;max-width:360px;border:3px solid #000;background:#fff;display:block;margin:0 auto'); im.src = R.prev_image; im.alt = '앞 친구의 그림'; box.append(im); }
        else box.append(el('div', 'text-align:center;opacity:.8', '앞 친구가 시간 안에 그리지 못했어요. 자유롭게 그려요!'));
      }
      S.pad = DrawPad.create(box);
      S.submitBtn = el('button', ''); S.submitBtn.type = 'button'; S.submitBtn.className = 'btn btn-main';
      S.submitBtn.onclick = () => send(link, R.step);
      box.append(S.submitBtn);
    } else {
      box.append(el('div', 'text-align:center', '마지막 그림이에요. 처음 제시어는 무엇이었을까요?'));
      if (R.prev_image) { const im = el('img', 'width:100%;max-width:400px;border:3px solid #000;background:#fff;display:block;margin:0 auto'); im.src = R.prev_image; im.alt = '마지막 그림'; box.append(im); }
      else box.append(el('div', 'text-align:center;opacity:.8', '그림이 없어요. 짐작해서 골라 보세요!'));
      const opts = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px');
      (R.options || []).forEach(o => {
        const b = el('button', 'padding:14px;font-size:1.1rem;font-weight:800', o); b.type = 'button'; b.className = 'btn btn-sub';
        b.onclick = async () => {
          S.picked = o; [...opts.children].forEach(x => { x.className = x === b ? 'btn btn-main' : 'btn btn-sub'; });
          try { await link.send('submit', { step: R.step, choice: o }); } catch (e) { alert(e.message); }
        };
        opts.append(b);
      });
      box.append(opts);
    }
    S.statusEl = el('div', 'text-align:center;font-size:.9rem'); box.append(S.statusEl);
    pc.append(box);
    S.timer = setInterval(() => tick(link, R.step), 500);
    update(R); tick(link, R.step);
    return true;
  }

  function update(R) {
    if (!S) return;
    S.endAt = Date.now() + R.remaining_ms;   // 서버 시간 기준으로 다시 맞춤
    S.submitted = R.submitted;
    if (S.submitBtn) S.submitBtn.textContent = R.submitted ? '✏️ 고쳐서 다시 내기' : '✅ 다 그렸어요 (내기)';
    S.statusEl.textContent = (R.submitted ? '냈어요! 시간 안에는 다시 고쳐 낼 수 있어요. · ' : '') + R.done + '/' + R.need + '명 냈어요';
  }

  async function send(link, step) {
    if (!S || !S.pad) return;
    S.submitBtn.disabled = true;
    try { await link.send('submit', { step, image: S.pad.toImage() }); }
    catch (e) { if (e.code !== 'step_over') alert(e.message); }
    if (S && S.submitBtn) S.submitBtn.disabled = false;
  }

  function tick(link, step) {
    if (!S) return;
    const left = Math.max(0, Math.ceil((S.endAt - Date.now()) / 1000));
    S.timerEl.textContent = '⏱ ' + left + '초';
    if (left > 0) return;
    // 시간 끝: 아직 안 냈으면 지금 그림을 자동으로 내고, 서버에 다음 단계로 넘기기를 요청
    if (!S.autoSent) {
      S.autoSent = true;
      const p = S.pad && !S.submitted ? link.send('submit', { step, image: S.pad.toImage() }).catch(() => {}) : Promise.resolve();
      p.then(() => setTimeout(() => link.send('tick').catch(() => {}), 800));
    }
  }

  // 끝난 뒤: 줄마다 제시어 → 그림들 → 마지막 답
  function reveal(pc, d) {
    stop();
    const R = d.relay;
    if (!R || R.phase !== 'reveal') return;
    pc.append(el('h2', '', '🖼 릴레이 다시 보기'));
    if (!R.kept) { pc.append(el('div', 'opacity:.8', '그림은 게임이 끝나고 1일 뒤 지워졌어요.')); return; }
    pc.append(el('div', 'font-size:.85rem;opacity:.8;margin-bottom:8px', '그림은 1일 동안만 남아요. 마음에 드는 내 그림은 "내 기기에 저장"을 눌러 주세요.'));
    R.chains.forEach(c => {
      const card = el('div', 'border-top:2px solid #3a2a3a;padding:12px 0');
      card.append(el('div', 'font-weight:800;margin-bottom:6px', '제시어 "' + c.word + '" ' + (c.correct ? '✅ 전달 성공!' : '❌ 전달 실패')));
      const row = el('div', 'display:flex;gap:8px;overflow-x:auto;padding-bottom:6px');
      c.items.forEach(x => {
        const cell = el('div', 'flex:none;width:150px;font-size:.8rem');
        if (x.kind === 'draw') {
          if (x.image) { const im = el('img', 'width:150px;border:2px solid #000;background:#fff;display:block'); im.src = x.image; im.alt = ''; cell.append(im); }
          else cell.append(el('div', 'width:150px;height:112px;border:2px dashed #555;display:flex;align-items:center;justify-content:center', '(못 그림)'));
          cell.append(el('div', '', (x.step + 1) + '. ' + x.nickname + (x.mine ? ' (나)' : '')));
          if (x.mine && x.image) { const a = el('a', 'font-size:.75rem', '내 기기에 저장'); a.href = x.image; a.download = '그림릴레이-' + c.word + '.' + (x.image.startsWith('data:image/png') ? 'png' : x.image.startsWith('data:image/jpeg') ? 'jpg' : 'webp'); cell.append(a); }
        } else {
          cell.append(el('div', 'width:150px;height:112px;border:2px solid #000;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.1rem', '"' + (x.choice || '?') + '"'));
          cell.append(el('div', '', '답: ' + x.nickname + (x.mine ? ' (나)' : '')));
        }
        row.append(cell);
      });
      if (!c.items.some(x => x.kind === 'guess')) row.append(el('div', 'flex:none;align-self:center;opacity:.8', '(답 없음)'));
      card.append(row); pc.append(card);
    });
  }

  window.BoldGames = window.BoldGames || {};
  window.BoldGames.draw_relay = { render, reveal, stop };
})();
