// 볼드하다 공통 로그인 모듈 (순수 JS, 빌드 없음). window.BoldAuth 로 노출.
// supabase-js 는 CDN 에서 불러오고, URL·공개 키는 /api/config 에서 받는다.
(function () {
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  let clientP = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.supabase && window.supabase.createClient) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('로그인 모듈을 불러오지 못했어요. 네트워크를 확인해 주세요.'));
      document.head.appendChild(s);
    });
  }

  function getClient() {
    if (!clientP) {
      clientP = (async () => {
        await loadScript(CDN);
        const res = await fetch('/api/config');
        const cfg = await res.json().catch(() => ({}));
        if (!res.ok || !cfg.supabaseUrl) throw new Error('서버 설정이 아직 준비되지 않았어요.');
        return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
        });
      })();
      clientP.catch(() => { clientP = null; }); // 실패 시 다음 호출에서 재시도
    }
    return clientP;
  }

  // 로그인 후 돌아갈 경로: 같은 사이트 안의 경로만 허용 (오픈 리다이렉트 방지)
  function safeNext(n, fallback) {
    n = String(n || '');
    if (n.charAt(0) === '/' && n.charAt(1) !== '/' && n.charAt(1) !== '\\' && !/[:\s]/.test(n)) return n;
    return fallback || '/me.html';
  }

  window.BoldAuth = {
    client: getClient,
    safeNext,
    async session() {
      const c = await getClient();
      const { data } = await c.auth.getSession();
      return data.session || null;
    },
    async signIn(provider, next) {
      const c = await getClient();
      const redirectTo = location.origin + '/account.html' + (next ? '?next=' + encodeURIComponent(next) : '');
      const options = { redirectTo };
      // 카카오: 이메일 권한(account_email)은 비즈앱 전환이 필요하므로 닉네임·프로필 이미지만 요청
      if (provider === 'kakao') options.scopes = 'profile_nickname profile_image';
      const { error } = await c.auth.signInWithOAuth({ provider, options });
      if (error) throw error;
    },
    // 네이버 로그인: 서버(/api/auth/naver/callback)가 넘겨준 1회용 토큰으로 세션 생성
    async verifyNaver(tokenHash) {
      const c = await getClient();
      const { error } = await c.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
      if (error) throw error;
    },
    async publicConfig() {
      const res = await fetch('/api/config');
      return res.ok ? res.json() : {};
    },
    async signOut() {
      const c = await getClient();
      await c.auth.signOut();
    },
    // 로그인 토큰을 붙여 /api/* 호출
    async api(path, opts) {
      const s = await this.session();
      if (!s) { const e = new Error('login_required'); e.status = 401; throw e; }
      opts = Object.assign({}, opts);
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers, { Authorization: 'Bearer ' + s.access_token });
      const res = await fetch(path, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || 'request_failed'); e.status = res.status; throw e; }
      return data;
    },
  };
})();
