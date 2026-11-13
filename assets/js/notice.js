// 서비스 화면 공지 띠 (약관 3조·처리방침 13조: 변경 시행 7일 전부터 서비스 화면에 알림)
// 기간이 지나면 저절로 보이지 않는다. "닫기"를 누르면 이 기기에서는 다시 보이지 않는다.
// 이전 공지(privacy-20261120, AI 이용 기록)는 이번 개정본에 포함되어 이 공지로 바꿨다.
(function () {
  const NOTICE = {
    id: 'policy-20261121',
    until: '2026-11-28',                       // 한국 날짜 기준, 이날까지 표시 (시행 후 1주 더)
    text: '📢 2026년 11월 21일부터 이용약관과 개인정보 처리방침이 바뀌어요. (작품 게시·팔로우·댓글 등 새 기능, AI 이용 기록)',
    links: [['이용약관', '/terms'], ['처리방침', '/privacy']],
  };
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (today > NOTICE.until) return;
  const KEY = 'bold_notice_closed_' + NOTICE.id;
  try { if (localStorage.getItem(KEY)) return; } catch (e) {}

  function show() {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    // 화면 맨 위에 띠로 넣어 아래 내용을 밀어낸다 (휴대폰 하단 AI 버튼 등을 가리지 않게)
    bar.style.cssText = 'position:relative;z-index:5;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center;' +
      'background:#1a1a2e;color:#fff;border-bottom:2px solid #ffd96b;padding:8px 16px;font-size:13px;line-height:1.4;text-align:center';
    const t = document.createElement('span'); t.textContent = NOTICE.text;
    bar.append(t);
    NOTICE.links.forEach(([label, href]) => {
      const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label + ' 보기';
      a.style.cssText = 'color:#ffd96b;font-weight:700';
      bar.append(a);
    });
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '닫기';
    x.style.cssText = 'background:#ffd96b;color:#1a1a2e;border:0;padding:4px 10px;font-weight:700;cursor:pointer';
    x.onclick = () => { try { localStorage.setItem(KEY, '1'); } catch (e) {} bar.remove(); };
    bar.append(x);
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
