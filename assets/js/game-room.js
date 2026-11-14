// 게임 방 연결 도구 (5단계). social-ui.js 다음에 불러온다. window.GameRoom
// 게임 화면은 이 도구만 쓴다: connect → onChange 로 방 상태를 받고, send 로 동작을 보낸다.
// 지금은 화면이 보일 때만 3초마다 서버에 "바뀐 것 있어?"(since=버전)를 물어보는 방식.
// 나중에 빠른 게임이 필요하면 이 파일 안쪽만 실시간 연결(Durable Objects WebSocket)로 바꾸면 되고, 게임 화면은 그대로 둔다.
(function () {
  const POLL_MS = 3000;

  function connect(roomId, handlers) {
    handlers = handlers || {};
    let version = null, timer = null, closed = false, busy = false, last = null;

    async function pull() {
      if (closed || busy) return;
      busy = true;
      try {
        const q = '/api/game-rooms?id=' + encodeURIComponent(roomId) + (version != null ? '&since=' + version : '');
        const d = await SocialUI.api(q);
        if (!d.unchanged) { version = d.version; last = d; handlers.onChange && handlers.onChange(d); }
      } catch (e) {
        handlers.onError && handlers.onError(e);
        if (e.status === 404 || e.status === 401) close();   // 방이 없어졌거나 나감
      } finally { busy = false; }
    }
    function schedule() {
      clearTimeout(timer);
      if (closed) return;
      timer = setTimeout(async () => { if (document.visibilityState === 'visible') await pull(); schedule(); }, POLL_MS);
    }
    function onVis() { if (document.visibilityState === 'visible' && !closed) pull(); }
    document.addEventListener('visibilitychange', onVis);

    // 동작 보내기: 성공하면 바로 새 상태를 받아 온다
    async function send(action, body) {
      const r = await SocialUI.api('/api/game-rooms', { method: 'POST', body: JSON.stringify(Object.assign({ action, room_id: roomId }, body || {})) });
      version = null; await pull();
      return r;
    }
    function close() { closed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); }

    pull().then(schedule);
    return { send, close, refresh: () => { version = null; return pull(); }, get state() { return last; } };
  }

  // 방 밖에서 쓰는 동작 (만들기·코드로 들어가기)
  const create = (game, maxPlayers) => SocialUI.api('/api/game-rooms', { method: 'POST', body: JSON.stringify({ action: 'create', game, max_players: maxPlayers }) });
  const join = code => SocialUI.api('/api/game-rooms', { method: 'POST', body: JSON.stringify({ action: 'join', code }) });

  window.GameRoom = { connect, create, join };
})();
