// 소셜 화면(둘러보기·프로필·게시물) 공통 도우미. auth-client.js 다음에 불러온다. window.SocialUI
(function () {
  const KIND = { draw: '✏️ 그림', character: '👗 캐릭터', storyboard: '🎬 스토리보드', story: '📖 그림책', dub: '🎤 더빙' };
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
    nav.append(f);
    if (s) { const gl = el('a', 'chip', '그룹'); gl.href = '/groups'; gl.style.textDecoration = 'none'; nav.append(gl); }
    if (s) { const b = bell(); nav.append(b); }
    nav.append(m); top.append(brand, nav); root.prepend(top);
  }

  // 🔔 알림 버튼 (읽지 않은 개수). 로그인했을 때만
  function bell() {
    const a = el('a', 'chip', '🔔'); a.id = 'bellLink'; a.href = '/notifications'; a.style.textDecoration = 'none'; a.title = '알림';
    api('/api/notifications?count=1').then(d => { if (d.unread) a.textContent = '🔔 ' + (d.unread >= 100 ? '99+' : d.unread); }).catch(() => {});
    return a;
  }

  // 사람 한 줄 (사진·닉네임 + 오른쪽 버튼들)
  function userRow(u, buttons) {
    const row = el('div', 'row2'); row.style.cssText = 'align-items:center;margin-bottom:10px';
    const a = el('a', 'author'); a.href = '/u?n=' + encodeURIComponent(u.nickname); a.style.margin = '0';
    const im = el('img'); im.alt = ''; im.src = avatar(u.avatar_url); a.append(im, el('span', '', u.nickname));
    const btns = el('div'); btns.style.cssText = 'display:flex;gap:6px;flex:none;justify-content:flex-end';
    (buttons || []).forEach(([label, fn, cls]) => { const b = el('button', 'chip ' + (cls || ''), label); b.type = 'button'; b.onclick = () => fn(b); btns.append(b); });
    row.append(a, btns);
    return row;
  }

  // 알림 문장
  const KIND_SANC = { warning: '경고', post_ban: '게시 금지', suspend: '이용 정지' };
  function notiText(n) {
    const who = n.actor ? n.actor.nickname + '님이 ' : '';
    const t = n.post_title ? '"' + n.post_title + '"' : '게시물';
    const reason = n.data && n.data.reason ? ' (사유: ' + n.data.reason + ')' : '';
    switch (n.type) {
      case 'follow': return who + '나를 팔로우했어요.';
      case 'follow_request': return who + '팔로우를 요청했어요. 마이페이지에서 수락할 수 있어요.';
      case 'follow_accept': return who + '팔로우 요청을 수락했어요.';
      case 'like': return who + t + '을(를) 좋아해요.';
      case 'comment': return who + t + '에 댓글을 남겼어요' + (n.data && n.data.preview ? ': ' + n.data.preview : '.');
      case 'post_approved': return t + '이(가) 공개됐어요.';
      case 'post_rejected': return t + '이(가) 공개되지 않았어요' + reason + '.';
      case 'post_hidden': return t + '이(가) 가려졌어요' + reason + '.';
      case 'post_removed': return t + '이(가) 삭제됐어요' + reason + '.';
      case 'comment_hidden': return '내 댓글이 ' + (n.data && n.data.removed ? '삭제' : '가려') + '졌어요' + reason + '.';
      case 'group_invite': return who + '"' + ((n.data && n.data.group_name) || '그룹') + '" 그룹에 초대했어요.';
      case 'group_join': return who + '"' + ((n.data && n.data.group_name) || '그룹') + '" 그룹에 들어왔어요.';
      case 'group_role': return '"' + ((n.data && n.data.group_name) || '그룹') + '" 그룹에서 내 역할이 "' + ({ owner: '모둠장', editor: '만들기', viewer: '보기' }[n.data && n.data.role] || '') + '"(으)로 바뀌었어요.';
      case 'gs_assigned': return who + '"' + ((n.data && n.data.title) || '그림책') + '"의 ' + (n.data && n.data.k === 'cover' ? '표지' : '장면 ' + ((n.data && n.data.ord) || '')) + '을(를) 맡겼어요.';
      case 'gs_submitted': return who + '"' + ((n.data && n.data.title) || '그림책') + '"의 ' + (n.data && n.data.k === 'cover' ? '표지' : '장면 ' + ((n.data && n.data.ord) || '')) + '을(를) 제출했어요. 확인해 주세요.';
      case 'gs_approved': return '"' + ((n.data && n.data.title) || '그림책') + '"의 ' + (n.data && n.data.k === 'cover' ? '표지' : '장면 ' + ((n.data && n.data.ord) || '')) + '이(가) 승인됐어요! 🎉';
      case 'gs_returned': return '"' + ((n.data && n.data.title) || '그림책') + '"의 ' + (n.data && n.data.k === 'cover' ? '표지' : '장면 ' + ((n.data && n.data.ord) || '')) + '을(를) 다시 고쳐 달래요' + reason + '.';
      case 'group_removed': return '"' + ((n.data && n.data.group_name) || '그룹') + '" 그룹에서 나가게 되었어요.';
      case 'sanction': return '이용 제한을 받았어요: ' + (KIND_SANC[n.data && n.data.kind] || '') + reason + '. 마이페이지에서 확인해 주세요.';
      default: return '새 알림';
    }
  }
  function notiLink(n) {
    if (n.type === 'follow' || n.type === 'follow_accept') return n.actor ? '/u?n=' + encodeURIComponent(n.actor.nickname) : null;
    if (/^gs_/.test(n.type) && n.data && n.data.story_id) return '/group-story?id=' + encodeURIComponent(n.data.story_id);
    if (n.type === 'group_invite' || n.type === 'group_removed') return '/groups';
    if ((n.type === 'group_join' || n.type === 'group_role') && n.data && n.data.group_id) return '/group?id=' + encodeURIComponent(n.data.group_id);
    if (n.type === 'follow_request' || n.type === 'sanction') return '/me.html';
    if (n.post_id && n.type !== 'post_removed') return '/post?id=' + encodeURIComponent(n.post_id);
    return null;
  }

  window.SocialUI = { api, session, card, el, date, avatar, report, disabledBox, header, bell, userRow, notiText, notiLink, KIND };
})();
