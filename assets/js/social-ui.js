// 소셜 화면(둘러보기·프로필·게시물) 공통 도우미. auth-client.js 다음에 불러온다. window.SocialUI
(function () {
  const KIND = { draw: '✏️ 그림', character: '👗 캐릭터', storyboard: '🎬 스토리보드', story: '📖 그림책', dub: '📚 더빙' };
  const REASONS = [
    ['inappropriate', '어린이에게 맞지 않는 그림이나 글'],
    ['bullying', '놀림·괴롭힘·욕설'],
    ['privacy', '다른 사람의 얼굴·이름·연락처 등 개인정보'],
    ['copyright', '다른 사람의 작품을 허락 없이 사용'],
    ['spam', '도배·광고'],
    ['other', '기타'],
  ];

  function hasSessionHint() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) return true; } } catch (e) {}
    return false;
  }
  async function session() { if (!hasSessionHint()) return null; try { return await BoldAuth.session(); } catch (e) { return null; } }

  // 로그인했으면 토큰을 붙여서, 아니면 그냥 호출. 실패하면 Error(서버 메시지)
  async function api(path, opts) {
    opts = Object.assign({}, opts);
    const s = await session();
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers, s ? { Authorization: 'Bearer ' + s.access_token } : {});
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || '요청에 실패했어요.'); e.status = res.status; e.code = data.code; throw e; }
    return data;
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const date = s => s ? new Date(s).toLocaleDateString('ko-KR') : '';
  const avatar = u => u || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#2d0040"/><circle cx="20" cy="16" r="7" fill="#a79aa8"/><rect x="8" y="26" width="24" height="12" rx="6" fill="#a79aa8"/></svg>');

  // 게시물 카드 (둘러보기·프로필 목록)
  function card(p) {
    const a = el('a', 'post-card'); a.href = '/post?id=' + encodeURIComponent(p.id);
    const img = el('img'); img.alt = p.title || ''; img.loading = 'lazy';
    if (p.cover && p.cover.url) img.src = p.cover.url; else img.className = 'noimg';
    const meta = el('div', 'post-meta');
    meta.append(el('div', 'post-title', p.title || '(제목 없음)'));
    meta.append(el('div', 'post-sub', (KIND[p.kind] || '') + (p.media_count > 1 ? ' · ' + p.media_count + '장' : '') + ' · ' + ((p.owner && p.owner.nickname) || '')));
    if (p.status_text) meta.append(el('div', 'post-status st-' + (p.status || ''), p.status_text));
    a.append(img, meta);
    return a;
  }

  function disabledBox(root, e) {
    root.innerHTML = '';
    const d = el('div', 'card');
    d.append(el('h2', '', '준비 중이에요'), el('p', 'sub', e && e.code === 'social_disabled' ? e.message : '잠시 뒤 다시 와 주세요.'));
    const a = el('a', 'btn btn-main', '← 제작 화면으로'); a.href = '/'; a.style.textDecoration = 'none';
    d.append(a); root.append(d);
  }

  // 신고 창
  function report(targetType, targetId) {
    return new Promise(async resolve => {
      if (!(await session())) {
        if (confirm('로그인하면 신고할 수 있어요. 로그인하러 갈까요?')) location.href = '/account.html?next=' + encodeURIComponent(location.pathname + location.search);
        return resolve(false);
      }
      const ov = el('div', 'modal-ov');
      const box = el('div', 'card modal-box');
      box.append(el('h2', '', '🚩 신고하기'), el('p', 'sub', '무엇이 문제인가요? 관리자가 확인해요. 신고한 사람은 상대에게 알려지지 않아요.'));
      const list = el('div');
      REASONS.forEach(([v, t], i) => {
        const l = el('label', 'consent'); const r = el('input'); r.type = 'radio'; r.name = 'rr'; r.value = v; if (!i) r.checked = true;
        l.append(r, el('span', '', t)); list.append(l);
      });
      const detail = el('textarea'); detail.maxLength = 500; detail.placeholder = '더 알려 줄 내용 (선택)';
      const msg = el('div', 'msg');
      const row = el('div', 'row2');
      const send = el('button', 'btn btn-main', '신고 보내기'); send.type = 'button';
      const close = el('button', 'btn btn-sub', '닫기'); close.type = 'button';
      row.append(send, close);
      box.append(list, detail, msg, row); ov.append(box); document.body.append(ov);
      close.onclick = () => { ov.remove(); resolve(false); };
      send.onclick = async () => {
        send.disabled = true;
        try {
          const reason = box.querySelector('input[name=rr]:checked').value;
          const r = await api('/api/reports', { method: 'POST', body: JSON.stringify({ target_type: targetType, target_id: targetId, reason, detail: detail.value }) });
          msg.className = 'msg ok'; msg.textContent = r.already ? '이미 신고했어요. 관리자가 확인할게요.' : '신고했어요. 고마워요!';
          setTimeout(() => { ov.remove(); resolve(true); }, 1200);
        } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; send.disabled = false; }
      };
    });
  }

  // 머리 부분: 홈 / 둘러보기 / 마이페이지(또는 로그인)
  async function header(root) {
    const top = el('div', 'top');
    const brand = el('a', 'brand', '볼드하다'); brand.href = '/';
    const nav = el('div', 'chips'); nav.style.marginTop = '0';
    const f = el('a', 'chip', '둘러보기'); f.href = '/feed'; f.style.textDecoration = 'none';
    const s = await session();
    const m = el('a', 'chip', s ? '마이페이지' : '로그인'); m.href = s ? '/me.html' : '/account.html?next=' + encodeURIComponent(location.pathname + location.search); m.style.textDecoration = 'none';
    nav.append(f, m); top.append(brand, nav); root.prepend(top);
  }

  window.SocialUI = { api, session, card, el, date, avatar, report, disabledBox, header, KIND };
})();
