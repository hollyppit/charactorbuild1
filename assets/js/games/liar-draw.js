// 숨은 라이어 그림 화면 (5단계 네 번째 게임). game-room.html 이 불러와 BoldGames.liar_draw 로 쓴다.
// 서버가 주는 d.liar: {phase:'word'|'draw'|'vote'|'reverse'|'result'|'reveal', round, rounds, mode:'told'|'fool', role, remaining_ms, need,
//   word?(내 제시어) | me_liar?{category}(알려 주는 방식의 라이어), submitted?, done?, draws?[{nickname, mine, image, liar?}], my_vote?, caught?, options?,
//   (result) liar, liar_is_me, category, word, liar_word, caught, liar_guess, liar_won, tally[{nickname, votes}] }
//   끝나면 {phase:'reveal', mode, rounds:[{… 위 결과 정보, draws}]}
(function () {
  const el = (t, css, text) => { const e = document.createElement(t); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const MODE = { told: '🕵️ 알려 주는 라이어', fool: '🤪 바보 라이어' };
  let S = null;

  function stop() { if (S) { clearInterval(S.timer); S = null; } }

  const myWordBox = L => {
    if (L.me_liar) return el('div', 'text-align:center;font-size:1.3rem;font-weight:900;color:#ff6b6b', '🕵️ 당신은 라이어예요! 분류: ' + L.me_liar.category + ' — 들키지 않게 그려 보세요');
    if (L.word) return el('div', 'text-align:center;font-size:1.6rem;font-weight:900;color:var(--yellow)', '제시어: ' + L.word);
    return el('div', 'text-align:center', '이번 게임은 구경하고 있어요.');
  };
  const card = (d, opts) => {
    const c = el('div', 'background:#fff;color:#111;border:3px solid ' + (opts && opts.hl ? '#ff4fa3' : '#000') + ';padding:4px;text-align:center;font-size:.85rem');
    if (d.image) { const im = el('img', 'width:100%;display:block;background:#fff'); im.src = d.image; im.alt = ''; c.append(im); }
    else c.append(el('div', 'aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;color:#888', '(못 그림)'));
    c.append(el('div', 'font-weight:800;margin-top:3px', (d.liar ? '🕵️ ' : '') + d.nickname + (d.mine ? ' (나)' : '')));
    return c;
  };
  const grid = () => el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px');

  function render(pc, d, link) {
    const L = d.liar;
    if (!L || L.phase === 'reveal') { stop(); return false; }
    // 투표 단계는 내가 고른 친구가 바뀌면 다시 그림 (그림판이 없어 다시 그려도 됨)
    const key = d.id + ':' + L.round + ':' + L.phase + (L.phase === 'vote' ? ':' + (L.my_vote || '') : '');
    if (S && S.key === key && pc.contains(S.box)) { update(L); return true; }
    stop(); pc.innerHTML = '';
    const box = el('div', 'display:flex;flex-direction:column;gap:10px');
    S = { key, box, link, round: L.round, phase: L.phase, endAt: Date.now() + L.remaining_ms, autoSent: false, submitted: !!L.submitted };
    const top = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap');
    const title = { word: '제시어 확인', draw: '그리기', vote: '라이어 찾기', reverse: '역전 기회', result: '결과' }[L.phase] || '';
    top.append(el('b', '', '🎭 숨은 라이어 그림 · ' + (L.round + 1) + '/' + L.rounds + '라운드 · ' + title));
    S.timerEl = el('b', 'font-size:1.3rem;color:var(--yellow)'); top.append(S.timerEl);
    box.append(top, el('div', 'font-size:.8rem;opacity:.85', MODE[L.mode] + (L.mode === 'fool' ? ' — 나만 다른 제시어를 받았을 수도 있어요!' : '')));

    if (L.phase === 'word') {
      box.append(myWordBox(L), el('div', 'text-align:center;font-size:.85rem;opacity:.85', '곧 모두 함께 그려요. 글자는 쓰지 말고 그림으로만!'));
    } else if (L.phase === 'draw') {
      box.append(myWordBox(L));
      if (L.role === 'player') {
        S.pad = DrawPad.create(box);
        S.btn = el('button', ''); S.btn.type = 'button'; S.btn.className = 'btn btn-main';
        S.btn.onclick = () => send(L.round);
        box.append(S.btn);
      }
    } else if (L.phase === 'vote') {
      box.append(myWordBox(L), el('div', 'text-align:center;font-weight:800', '라이어 같은 친구의 그림을 골라요 (다시 눌러 바꿀 수 있어요)'));
      const g = grid();
      (L.draws || []).forEach(x => {
        const c = card(x, { hl: L.my_vote === x.nickname });
        if (!x.mine && L.role === 'player') {
          c.style.cursor = 'pointer';
          const b = el('button', 'margin-top:4px;width:100%', L.my_vote === x.nickname ? '✅ 내가 고른 친구' : '이 친구가 라이어!'); b.type = 'button'; b.className = L.my_vote === x.nickname ? 'btn btn-main' : 'btn btn-sub';
          b.style.padding = '6px'; b.style.fontSize = '.8rem';
          b.onclick = async () => { try { await link.send('submit', { round: L.round, vote: x.nickname }); } catch (e) { alert(e.message); } };
          c.append(b);
        }
        g.append(c);
      });
      box.append(g);
    } else if (L.phase === 'reverse') {
      box.append(el('div', 'text-align:center;font-size:1.2rem;font-weight:900', '🚨 ' + L.caught + '님이 라이어로 잡혔어요!'));
      if (L.options) {
        box.append(el('div', 'text-align:center;font-weight:800', '친구들의 진짜 제시어를 맞히면 역전이에요! 무엇이었을까요?'));
        const row = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px');
        L.options.forEach(o => {
          const b = el('button', 'padding:14px;font-size:1.1rem;font-weight:900', o); b.type = 'button'; b.className = 'btn btn-sub';
          b.onclick = async () => { [...row.children].forEach(x => { x.disabled = true; x.className = x === b ? 'btn btn-main' : 'btn btn-sub'; }); try { await link.send('submit', { round: L.round, choice: o }); } catch (e) { alert(e.message); } };
          row.append(b);
        });
        box.append(row);
      } else box.append(el('div', 'text-align:center', L.caught + '님이 진짜 제시어를 맞히면 라이어가 역전해요...'));
      const g = grid(); (L.draws || []).forEach(x => g.append(card(x))); box.append(g);
    } else if (L.phase === 'result') {
      box.append(el('div', 'text-align:center;font-size:1.4rem;font-weight:900', L.liar_won ? '🕵️ 라이어 ' + L.liar + ' 승리!' : '🎉 라이어 ' + L.liar + '을(를) 잡았어요!'));
      const why = L.liar_won ? (L.caught ? '잡혔지만 진짜 제시어 "' + L.liar_guess + '"을(를) 맞혀 역전했어요!' : '라이어를 찾지 못했어요.') : (L.liar_guess ? '역전 기회에서 "' + L.liar_guess + '"을(를) 골랐지만 틀렸어요.' : '');
      if (why) box.append(el('div', 'text-align:center', why));
      box.append(el('div', 'text-align:center;font-weight:800', '친구들 제시어: ' + L.word + (L.mode === 'fool' ? ' · 라이어 제시어: ' + (L.liar_word || '?') : ' · 분류: ' + L.category)));
      box.append(el('div', 'text-align:center;font-size:.85rem', '투표: ' + L.tally.filter(t => t.votes).map(t => t.nickname + ' ' + t.votes + '표').join(' · ') + (L.my_vote ? ' (내 선택: ' + L.my_vote + ')' : '')));
      const g = grid(); (L.draws || []).forEach(x => g.append(card(x, { hl: x.liar }))); box.append(g);
    }
    S.statusEl = el('div', 'text-align:center;font-size:.9rem'); box.append(S.statusEl);
    pc.append(box);
    S.timer = setInterval(tick, 500);
    update(L); tick();
    return true;
  }

  function update(L) {
    if (!S) return;
    S.endAt = Date.now() + L.remaining_ms;
    S.submitted = !!L.submitted;
    if (S.btn) S.btn.textContent = L.submitted ? '✏️ 고쳐서 다시 내기' : '✅ 다 그렸어요 (내기)';
    if (L.phase === 'draw') S.statusEl.textContent = (L.submitted ? '냈어요! 시간 안에는 다시 고쳐 낼 수 있어요. · ' : '') + (L.done || 0) + '/' + L.need + '명 냈어요';
    else if (L.phase === 'vote') S.statusEl.textContent = (L.done || 0) + '/' + L.need + '명 투표했어요';
  }

  async function send(round) {
    if (!S || !S.pad) return;
    S.btn.disabled = true;
    try { await S.link.send('submit', { round, image: S.pad.toImage() }); } catch (e) { if (e.code !== 'step_over') alert(e.message); }
    if (S && S.btn) S.btn.disabled = false;
  }

  function tick() {
    if (!S) return;
    const left = Math.max(0, Math.ceil((S.endAt - Date.now()) / 1000));
    S.timerEl.textContent = '⏱ ' + left + '초';
    if (left > 0 || S.autoSent) return;
    S.autoSent = true;
    const link = S.link, round = S.round;
    const p = S.pad && S.phase === 'draw' && !S.submitted ? link.send('submit', { round, image: S.pad.toImage() }).catch(() => {}) : Promise.resolve();
    p.then(() => setTimeout(() => link.send('tick').catch(() => {}), 600));
  }

  // 끝난 뒤: 라운드마다 라이어·제시어·투표·그림
  function reveal(pc, d) {
    stop();
    const L = d.liar;
    if (!L || L.phase !== 'reveal') return;
    pc.append(el('h2', '', '🖼 라운드 다시 보기'));
    pc.append(el('div', 'font-size:.85rem;opacity:.8;margin-bottom:8px', MODE[L.mode] + ' · 그림은 1일 동안만 남아요. 내 그림은 "내 그림 저장"을 눌러 주세요.'));
    L.rounds.forEach(x => {
      const c = el('div', 'border-top:2px solid #3a2a3a;padding:12px 0');
      c.append(el('div', 'font-weight:800', (x.round + 1) + '라운드 · 라이어 ' + x.liar + (x.liar_is_me ? ' (나)' : '') + ' · ' + (x.liar_won ? '🕵️ 라이어 승리' : '🎉 시민 승리')));
      c.append(el('div', 'font-size:.85rem;margin:4px 0', '제시어 ' + x.word + (L.mode === 'fool' ? ' / 라이어 제시어 ' + (x.liar_word || '?') : ' / 분류 ' + x.category) + (x.liar_guess ? ' · 역전 답 "' + x.liar_guess + '"' : '')));
      const g = grid(); x.draws.forEach(dd => g.append(card(dd, { hl: dd.liar }))); c.append(g);
      x.draws.filter(dd => dd.mine && dd.image).forEach(dd => { const a = el('a', 'font-size:.75rem;display:inline-block;margin-top:4px', '내 그림 저장'); a.href = dd.image; a.download = '숨은라이어-' + (x.round + 1) + '라운드.' + (dd.image.startsWith('data:image/png') ? 'png' : dd.image.startsWith('data:image/jpeg') ? 'jpg' : 'webp'); c.append(a); });
      pc.append(c);
    });
  }

  window.BoldGames = window.BoldGames || {};
  window.BoldGames.liar_draw = { render, reveal, stop };
})();
