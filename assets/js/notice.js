// 서비스 화면 공지 띠 (개인정보 처리방침 변경 사전 고지 — 방침 13조: 시행 7일 전부터 알림)
// 기간이 지나면 저절로 보이지 않는다. "닫기"를 누르면 이 기기에서는 다시 보이지 않는다.
(function () {
  const NOTICE = {
    id: 'privacy-20261120',
    until: '2026-11-27',                       // 한국 날짜 기준, 이날까지 표시 (시행 후 1주 더)
    text: '📢 개인정보 처리방침이 2026년 11월 20일부터 바뀌어요. (AI 이용 기록 항목 추가)',
    link: '/privacy',
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
    const a = document.createElement('a'); a.href = NOTICE.link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '자세히 보기';
    a.style.cssText = 'color:#ffd96b;font-weight:700';
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '닫기';
    x.style.cssText = 'background:#ffd96b;color:#1a1a2e;border:0;padding:4px 10px;font-weight:700;cursor:pointer';
    x.onclick = () => { try { localStorage.setItem(KEY, '1'); } catch (e) {} bar.remove(); };
    bar.append(t, a, x);
    document.body.insertBefore(bar, document.body.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
