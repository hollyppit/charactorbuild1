// 새 알림 바로 보여 주기. auth-client.js 다음에 불러온다.
// 로그인한 회원에게만: 페이지를 열 때와 1분마다(화면을 보고 있을 때만) 읽지 않은 알림을 확인해,
// 아직 보여 주지 않은 새 알림을 오른쪽 아래(휴대폰은 아래쪽 가운데)에 잠깐 띄우고 🔔 숫자도 고친다.
// 알림 화면(/notifications)에서는 띄우지 않는다. 소셜 기능이 꺼져 있으면 조용히 멈춘다.
(function () {
  if (!window.BoldAuth || /^\/notifications/.test(location.pathname)) return;
  const SEEN_KEY = 'bold_noti_seen';          // 이 기기에서 이미 띄운 알림의 가장 큰 id
  const KIND_SANC = { warning: '경고', post_ban: '게시 금지', suspend: '이용 정지' };
  let stopped = false, timer = null, box = null;

  function hasSessionHint() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) return true; } } catch (e) {}
    return false;
  }
  const getSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY) || 0); } catch (e) { return 0; } };
  const setSeen = v => { try { localStorage.setItem(SEEN_KEY, String(v)); } catch (e) {} };

  // 알림 문장 (social-ui.js 와 같은 규칙. 이 파일은 제작 화면에서도 쓰므로 따로 둔다)
  function text(n) {
    const who = n.actor ? n.actor.nickname + '님이 ' : '';
    const t = n.post_title ? '"' + n.post_title + '"' : '게시물';
    const reason = n.data && n.data.reason ? ' (사유: ' + n.data.reason + ')' : '';
    switch (n.type) {
      case 'follow': return who + '나를 팔로우했어요.';
      case 'follow_request': return who + '팔로우를 요청했어요.';
      case 'follow_accept': return who + '팔로우 요청을 수락했어요.';
      case 'like': return who + t + '을(를) 좋아해요.';
      case 'comment': return who + '댓글을 남겼어요' + (n.data && n.data.preview ? ': ' + n.data.preview : '.');
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
      case 'game_invite': return who + '"' + ((n.data && n.data.game) || '게임') + '" 방에 초대했어요. 🎮';
      case 'gp_consent': return who + '"' + ((n.data && n.data.title) || '그림책') + '"을(를) 게시하자고 해요. 함께 만든 사람으로 동의해 줄래요?';
      case 'gp_declined': return who + '"' + ((n.data && n.data.title) || '그림책') + '" 게시에 동의하지 않았어요. 이번 게시는 취소됐어요.';
      case 'gp_ready': return '"' + ((n.data && n.data.title) || '그림책') + '" 게시에 모두 동의했어요! 작업 화면에서 게시할 수 있어요.';
      case 'gp_published': return who + '함께 만든 "' + ((n.data && n.data.title) || '그림책') + '"을(를) 게시했어요. 🎉';
      case 'sanction': return '이용 제한을 받았어요: ' + (KIND_SANC[n.data && n.data.kind] || '') + reason + '.';
      default: return '새 알림이 있어요.';
    }
  }
  function link(n) {
    if ((n.type === 'follow' || n.type === 'follow_accept') && n.actor) return '/u?n=' + encodeURIComponent(n.actor.nickname);
    if (/^gs_/.test(n.type) && n.data && n.data.story_id) return '/group-story?id=' + encodeURIComponent(n.data.story_id);
    if (n.type === 'game_invite' && n.data && n.data.code) return '/games?code=' + encodeURIComponent(n.data.code);
    if (n.type === 'gp_consent' && n.data && n.data.request_id) return '/group-publish?id=' + encodeURIComponent(n.data.request_id);
    if ((n.type === 'gp_declined' || n.type === 'gp_ready') && n.data && n.data.story_id) return '/group-story?id=' + encodeURIComponent(n.data.story_id);
    if (n.type === 'group_invite' || n.type === 'group_removed') return '/groups';
    if ((n.type === 'group_join' || n.type === 'group_role') && n.data && n.data.group_id) return '/group?id=' + encodeURIComponent(n.data.group_id);
    if (n.type === 'follow_request' || n.type === 'sanction') return '/me.html';
    if (n.post_id && n.type !== 'post_removed') return '/post?id=' + encodeURIComponent(n.post_id);
    return '/notifications';
  }

  function setBell(unread) {
    document.querySelectorAll('#bellLink').forEach(b => { b.textContent = unread ? '🔔 ' + (unread >= 100 ? '99+' : unread) : '🔔'; });
  }

  function show(list, unread) {
    if (box) box.remove();
    box = document.createElement('div');
    box.setAttribute('role', 'status');
    const narrow = window.innerWidth < 560;
    box.style.cssText = 'position:fixed;z-index:99998;background:#1a1a2e;color:#fff;border:2px solid #ffd96b;box-shadow:0 6px 18px rgba(0,0,0,.4);' +
      'padding:10px 12px;font-size:14px;line-height:1.45;max-width:360px;width:calc(100% - 24px);' +
      (narrow ? 'left:50%;transform:translateX(-50%);bottom:84px;' : 'right:16px;bottom:16px;');
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:800;margin-bottom:6px;color:#ffd96b';
    const ht = document.createElement('span'); ht.textContent = '🔔 새 알림' + (unread > list.length ? ' (' + unread + '개 중 ' + list.length + '개)' : '');
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.setAttribute('aria-label', '닫기');
    x.style.cssText = 'background:none;border:0;color:#fff;font-size:16px;cursor:pointer;padding:0 4px';
    x.onclick = () => { box.remove(); box = null; };
    head.append(ht, x); box.append(head);
    list.forEach(n => {
      const a = document.createElement('a'); a.href = link(n); a.textContent = text(n);
      a.style.cssText = 'display:block;color:#fff;text-decoration:none;padding:5px 0;border-top:1px solid #3a2a3a';
      box.append(a);
    });
    const all = document.createElement('a'); all.href = '/notifications'; all.textContent = '알림 모두 보기 →';
    all.style.cssText = 'display:block;color:#ffd96b;font-weight:700;margin-top:6px;text-decoration:none';
    box.append(all);
    document.body.append(box);
    clearTimeout(box._t);
    box._t = setTimeout(() => { if (box) { box.remove(); box = null; } }, 12000);
  }

  async function check() {
    if (stopped || document.visibilityState === 'hidden') return;
    try {
      const c = await BoldAuth.api('/api/notifications?count=1');
      setBell(c.unread);
      if (!c.unread) return;
      const d = await BoldAuth.api('/api/notifications');
      const seen = getSeen();
      const fresh = d.notifications.filter(n => !n.read && n.id > seen);
      if (!fresh.length) return;
      setSeen(Math.max(seen, ...fresh.map(n => n.id)));
      show(fresh.slice(0, 3), d.unread);
    } catch (e) {
      if (e.status === 401 || e.status === 404 || e.status === 503) stopped = true;   // 로그아웃·기능 꺼짐 → 그만
    }
  }

  async function init() {
    if (!hasSessionHint()) return;
    try { if (!(await BoldAuth.session())) return; } catch (e) { return; }
    setTimeout(check, 1500);                     // 화면이 먼저 그려진 뒤
    timer = setInterval(check, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
