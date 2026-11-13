// 관리자: AI 사용량 요약과 하루 한도 변경 (AI 비밀번호 설정 창 안). 관리자 헤더는 index.html 의 fetch 래퍼가 붙인다.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = v => Number(v || 0).toLocaleString('ko-KR');

  async function load() {
    const box = $('aiUsageAdmin');
    box.style.display = '';
    box.textContent = '불러오는 중...';
    try {
      const r = await fetch('/api/ai-usage?admin=1&days=14');
      const d = await r.json().catch(() => ({}));
      if (r.status === 503 && d.error === 'usage_not_ready') { box.textContent = 'AI 사용 기록 기능이 아직 설치되지 않았어요 (DB 0008 적용 필요).'; return; }
      if (!r.ok) { box.textContent = '불러오지 못했어요 (' + (d.error || r.status) + ')'; return; }
      render(d);
    } catch (e) { box.textContent = '불러오지 못했어요.'; }
  }

  function render(d) {
    const L = d.limits || {};
    const cost = L.cost || {};
    const rows = (d.days || []).map(x => '<tr><td>' + esc(x.day) + '</td><td>' + n(x.credits) + '</td><td>' + n(x.member_credits) + '</td><td>' + n(x.guest_credits) +
      '</td><td>' + n(x.images) + '</td><td>' + n(x.calls) + (x.failed ? ' (실패 ' + n(x.failed) + ')' : '') + '</td></tr>').join('');
    const top = (d.top || []).map(x => '<tr><td>' + esc(x.nickname || '(이름 없음)') + '</td><td>' + n(x.credits) + '</td><td>' + n(x.calls) + '</td></tr>').join('');
    const inp = (id, v) => '<input type="number" min="0" id="' + id + '" value="' + esc(v) + '" style="width:90px;padding:4px;background:#1a0010;border:1px solid #666;color:#fff">';
    const th = 'style="text-align:left;padding:2px 6px;color:#aaa"';
    $('aiUsageAdmin').innerHTML =
      '<div style="font-weight:700;margin:4px 0">하루 한도 (점수: 그림 ' + esc(cost.image) + ' · 목소리 ' + esc(cost.tts) + ' · 글 ' + esc(cost.text) + ')</div>' +
      '<div style="display:grid;grid-template-columns:auto auto;gap:6px 8px;align-items:center">' +
      '<span>회원 1인</span>' + inp('aiLimMember', L.member_daily) +
      '<span>비회원 같은 인터넷 주소</span>' + inp('aiLimGuestIp', L.guest_ip_daily) +
      '<span>비회원 전체</span>' + inp('aiLimGuestTotal', L.guest_total_daily) + '</div>' +
      '<button class="btn btn-yellow" id="btnAiLimSave" style="margin:8px 0;padding:6px 12px">한도 저장</button> <span id="aiLimMsg"></span>' +
      '<div style="font-weight:700;margin:8px 0 4px">최근 14일 (한국 날짜, 실패는 점수에서 빠짐)</div>' +
      '<table style="border-collapse:collapse;width:100%"><tr><th ' + th + '>날짜</th><th ' + th + '>점수</th><th ' + th + '>회원</th><th ' + th + '>비회원</th><th ' + th + '>그림</th><th ' + th + '>호출</th></tr>' +
      (rows || '<tr><td colspan="6" style="padding:4px 6px;color:#888">아직 기록이 없어요</td></tr>') + '</table>' +
      '<div style="font-weight:700;margin:10px 0 4px">최근 7일 많이 쓴 회원</div>' +
      '<table style="border-collapse:collapse;width:100%"><tr><th ' + th + '>닉네임</th><th ' + th + '>점수</th><th ' + th + '>호출</th></tr>' +
      (top || '<tr><td colspan="3" style="padding:4px 6px;color:#888">아직 기록이 없어요</td></tr>') + '</table>';
    $('btnAiLimSave').onclick = saveLimits;
  }

  async function saveLimits() {
    const msg = $('aiLimMsg');
    const v = id => parseInt($(id).value, 10);
    const body = { member_daily: v('aiLimMember'), guest_ip_daily: v('aiLimGuestIp'), guest_total_daily: v('aiLimGuestTotal') };
    if (Object.values(body).some(x => !Number.isInteger(x) || x < 0)) { msg.textContent = '0 이상의 숫자를 넣어 주세요'; return; }
    msg.textContent = '저장 중...';
    try {
      const r = await fetch('/api/ai-usage?action=limits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      msg.textContent = r.ok ? '저장했어요 ✓' : '저장하지 못했어요';
    } catch (e) { msg.textContent = '저장하지 못했어요'; }
  }

  function init() { const b = $('btnAiUsageAdmin'); if (b) b.onclick = load; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
