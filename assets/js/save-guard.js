// 비회원 서버 저장 막기 + 회원 로그인 토큰 첨부(저장·AI). auth-client.js 다음에 불러온다.
// 직접 그리기의 "☁️ 새 저장 / 🔄 중간 저장"(이름+비밀번호 서버 저장)은 로그인한 사람(또는 관리자)만 쓸 수 있다.
// 비회원이 누르면 로그인 안내를 보여 준다. PNG 내려받기, 이 기기 자동 저장, 예전 저장 불러오기·삭제는 그대로 둔다.
// 서버(/api/saves POST·PUT)도 로그인 토큰이 없으면 401 로 막으므로, 로그인한 사용자의 요청에는 토큰을 붙인다.
(function () {
  if (!window.BoldAuth) return;

  function hasSessionHint() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) return true; } } catch (e) {}
    return false;
  }
  // 로그인 흔적이 없으면 서버·라이브러리를 부르지 않고 바로 "비회원"으로 판단
  async function currentSession() {
    if (!hasSessionHint()) return null;
    try { return await BoldAuth.session(); } catch (e) { return null; }
  }
  const isAdminNow = () => !!window._adminHash;

  function askLogin() {
    if (confirm('저장은 로그인한 회원만 할 수 있어요.\n로그인하면 그림을 내 계정에 저장하고 다른 기기에서도 열 수 있어요.\n(지금 그림은 이 기기에 자동 저장돼 있어요)\n\n[확인] 로그인하러 가기')) {
      location.href = '/account.html?next=' + encodeURIComponent('/');
    }
  }

  // 저장 버튼 함수 감싸기: 비회원이면 안내만 하고 원래 동작은 하지 않음
  function guard(name) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = async function () {
      if (!isAdminNow() && !(await currentSession())) { askLogin(); return; }
      return orig.apply(this, arguments);
    };
  }
  ['openNewDrawSave', 'openQuickSave', 'doDrawSave'].forEach(guard);

  // 회원이면 AI 비밀번호 창을 건너뛴다 (서버가 로그인 토큰으로 확인하고 회원별 하루 한도를 적용)
  window._boldMember = false;
  currentSession().then(s => { window._boldMember = !!(s && s.access_token); });

  // 로그인한 사용자의 /api/saves 저장 요청과 AI 요청에 로그인 토큰 첨부
  const AI_PATH = /^\/api\/(?:imagine|storyboard|story-text|story-scene|story-direct|story-tts)(?:[?#]|$)/;
  const prevFetch = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = String((init && init.method) || 'GET').toUpperCase();
      if ((/^\/api\/saves(?:[?#]|$)/.test(url) && (method === 'POST' || method === 'PUT')) || (AI_PATH.test(url) && method === 'POST')) {
        const s = await currentSession();
        if (s && s.access_token) {
          init = Object.assign({}, init);
          const h = new Headers(init.headers || {});
          if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + s.access_token);
          init.headers = h;
        }
      }
    } catch (e) {}
    return prevFetch.call(this, input, init);
  };
})();
