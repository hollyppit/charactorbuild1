// 직접 그리기 ↔ 계정 저장 어댑터. auth-client.js, cloud-save.js 다음에 불러온다.
// 로그인한 사용자에게만 버튼을 보여 주며, 기존 비밀번호 저장·브라우저 자동 저장 코드는 건드리지 않는다.
// index.html 의 전역 변수/함수(drawLayers, _createDrawLayer, initDrawCanvas 등)를 사용한다.
(function () {
  const QS = new URLSearchParams(location.search);   // 다른 스크립트가 주소를 바꾸기 전에 읽어 둠
  const $ = id => document.getElementById(id);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LAST_KEY = 'bold_cloud_draw_last';   // 새로고침 뒤 "이어서 저장" 안내용 (자동 연결은 하지 않음)
  let cur = null;                             // { id, title, syncer }

  const toBlob = (canvas, type, q) => new Promise(r => canvas.toBlob(r, type, q));
  const today = () => new Date().toISOString().slice(0, 10);
  function setStatus(text, kind) {
    const el = $('cloudStatus'); if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#ff5b6b' : kind === 'ok' ? '#2dbd6e' : '#bbb';
  }
  function remember(id, title) { try { localStorage.setItem(LAST_KEY, JSON.stringify({ id, title })); } catch (e) {} }
  function lastBound() { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { return null; } }

  // 현재 그림판 상태 → 저장용 데이터 (레이어 이미지는 파일로 따로 올리고 id 로 참조)
  async function buildState(projectId) {
    const layers = [];
    for (const l of drawLayers) {
      const type = l.kind === 'draw' ? 'image/png' : 'image/jpeg';
      const blob = await toBlob(l.canvas, type, 0.85);
      if (!blob) throw new Error('캔버스를 이미지로 만들지 못했어요.');
      const asset = await CloudSave.uploadAsset(projectId, blob);
      layers.push({ name: l.name, kind: l.kind, opacity: l.opacity, visible: l.visible, locked: l.locked, asset });
    }
    const thumbBlob = await (await fetch(_makeDrawThumbnail())).blob();
    const thumbAsset = await CloudSave.uploadAsset(projectId, thumbBlob);
    return {
      data: { v: 1, canvas: { ratioW: drawCanvasRatioW, ratioH: drawCanvasRatioH, baseW: drawCanvasBaseW, baseH: drawCanvasBaseH }, layers },
      thumbAsset,
    };
  }

  function bind(id, title, version) {
    if (cur && cur.syncer) cur.syncer.stop();
    const syncer = CloudSave.syncer({
      projectId: id, version,
      debounceMs: 8000, minIntervalMs: 30000,
      getState: () => buildState(id),
      onStatus: (s, text) => setStatus(s === 'saved' ? '☁ ' + text : text, s === 'saved' ? 'ok' : (s === 'error' || s === 'conflict') ? 'err' : ''),
      onConflict: () => resolveConflict(),
    });
    cur = { id, title, syncer };
    remember(id, title);
    const btn = $('btnCloudSave'); if (btn) btn.textContent = '☁ 저장됨: ' + (title.length > 10 ? title.slice(0, 10) + '…' : title);
  }
  function unbind(msg) {
    if (cur && cur.syncer) cur.syncer.stop();
    cur = null;
    const btn = $('btnCloudSave'); if (btn) btn.textContent = '☁ 계정에 저장';
    if (msg) setStatus(msg);
  }

  // 다른 기기·탭에서 먼저 저장했을 때
  async function resolveConflict() {
    const id = cur.id, title = cur.title;
    if (confirm('다른 기기(또는 다른 창)에서 이 작업이 먼저 저장되었어요.\n\n[확인] 지금 화면 내용으로 덮어쓰기 (이전 내용은 버전으로 보관돼요)\n[취소] 다른 방법 고르기')) {
      try { const d = await CloudSave.open(id); cur.syncer.setVersion(d.project.version); cur.syncer.flush(); } catch (e) { setStatus('저장 실패 · 다시 시도해 주세요', 'err'); }
      return;
    }
    if (confirm('서버에 저장된 작업을 불러올까요?\n(지금 화면 내용은 사라져요)\n\n[확인] 서버 작업 불러오기\n[취소] 지금 화면을 새 작업(복사본)으로 저장')) {
      openProject(id, { skipConfirm: true });
      return;
    }
    try {
      const p = await CloudSave.create('draw', title + ' (복사본)', {});
      bind(p.id, p.title || title + ' (복사본)', p.version);
      cur.syncer.flush();
    } catch (e) { setStatus('복사본을 만들지 못했어요', 'err'); }
  }

  async function saveClick() {
    const btn = $('btnCloudSave');
    try {
      if (cur) { btn.disabled = true; await cur.syncer.flush(); return; }
      // 새로고침 뒤: 이전에 연결했던 작업이 있으면 이어서 저장할지 선택
      const last = lastBound();
      if (last && UUID.test(last.id || '')) {
        if (confirm('"' + (last.title || '이전 작업') + '"에 이어서 저장할까요?\n(그 작업의 내용이 지금 화면으로 바뀌어요. 이전 내용은 버전으로 보관돼요.)\n\n[취소]를 누르면 새 작업으로 저장해요.')) {
          try {
            const d = await CloudSave.open(last.id);
            if (!d.project.deleted_at) { btn.disabled = true; bind(last.id, d.project.title || last.title, d.project.version); await cur.syncer.flush(); return; }
          } catch (e) { /* 없어졌으면 새 작업으로 */ }
        }
      }
      const title = prompt('작업 이름을 정해 주세요', '그림 ' + today());
      if (title == null) return;
      btn.disabled = true;
      const p = await CloudSave.create('draw', title.trim() || '그림 ' + today(), {});
      bind(p.id, p.title, p.version);
      await cur.syncer.flush();
    } catch (e) {
      setStatus(e.message === 'quota_exceeded' ? '저장 공간이 가득 찼어요 · 마이페이지에서 정리해 주세요' : '저장 실패 · 다시 시도해 주세요', 'err');
    } finally { btn.disabled = false; }
  }

  function ensureDrawMode() {
    return new Promise(resolve => {
      const panel = $('panel-draw');
      if (panel && !panel.classList.contains('active')) {
        const tab = document.querySelector('.mode-tab[onclick*="\'draw\'"]');
        if (typeof switchMode === 'function') switchMode('draw', tab);
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  async function loadBitmap(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return createImageBitmap(await res.blob());
  }

  async function openProject(id, opts) {
    opts = opts || {};
    if (!opts.skipConfirm && !confirm('현재 작업 중인 내용이 모두 지워집니다. 불러올까요?')) return;
    try {
      setStatus('불러오는 중...');
      const d = await CloudSave.open(id);
      const data = d.project.data;
      if (!data || data.v !== 1 || !Array.isArray(data.layers)) throw new Error('이 작업은 직접 그리기에서 열 수 없어요.');
      await ensureDrawMode();

      if (data.canvas && data.canvas.ratioW && data.canvas.ratioH) {
        drawCanvasRatioW = data.canvas.ratioW; drawCanvasRatioH = data.canvas.ratioH;
        if (typeof _updateOrientationButtons === 'function') _updateOrientationButtons();
      }
      drawLayers = []; drawLayerCounter = 0; activeDrawLayerId = null;
      initDrawCanvas();
      drawLayers = [];
      $('drawCanvasStack').innerHTML = '';

      for (const m of data.layers) {
        const layer = _createDrawLayer({ kind: m.kind === 'image' ? 'image' : 'draw', name: m.name, opacity: m.opacity ?? 1, locked: !!m.locked });
        layer.visible = m.visible ?? true;
        const a = d.assets[m.asset];
        if (!a) continue;                       // 파일이 없으면 빈 레이어로 둠 (앱이 깨지지 않게)
        try {
          const bmp = await loadBitmap(a.url);
          const ctx = layer.canvas.getContext('2d');
          ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
          ctx.drawImage(bmp, 0, 0, layer.canvas.width, layer.canvas.height);
          if (bmp.close) bmp.close();
        } catch (e) { console.warn('레이어 불러오기 실패(빈 레이어로 유지):', e); }
      }
      _rebuildDrawLayerStackDOM();
      _renderDrawLayersList();

      // 예전 비밀번호 저장 세션이 남아 있으면 이 작업을 덮어쓰지 않도록 끊음
      if (typeof _drawSaveSession !== 'undefined') _drawSaveSession = null;
      const q = $('btnDrawQuickSave'); if (q) q.textContent = '🔄 중간 저장';
      bind(id, d.project.title || '', d.project.version);
      setStatus('☁ 불러왔어요', 'ok');
      const m = $('cloudOpenModal'); if (m) m.remove();
    } catch (e) {
      setStatus('불러오기 실패: ' + (e.message === 'not_found' ? '작업을 찾을 수 없어요' : e.message), 'err');
    }
  }

  async function openListClick() {
    const old = $('cloudOpenModal'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'cloudOpenModal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1c000c;border:3px solid #000;box-shadow:6px 6px 0 #a11cee;color:#fff;max-width:480px;width:100%;max-height:80vh;overflow:auto;padding:18px';
    const h = document.createElement('div'); h.textContent = '☁ 내 작업 열기'; h.style.cssText = 'font-weight:800;font-size:1.1rem;margin-bottom:12px';
    const list = document.createElement('div'); list.textContent = '불러오는 중...';
    const close = document.createElement('button'); close.textContent = '닫기'; close.style.cssText = 'margin-top:12px;padding:10px 16px;font-weight:700;cursor:pointer';
    close.onclick = () => ov.remove();
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
    box.append(h, list, close); ov.appendChild(box); document.body.appendChild(ov);
    try {
      const d = await CloudSave.list({ kind: 'draw' });
      list.innerHTML = '';
      if (!d.projects.length) { list.textContent = '저장된 그림이 없어요. "☁ 계정에 저장"으로 먼저 저장해 보세요.'; return; }
      d.projects.forEach(p => {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:10px';
        const img = document.createElement('img'); img.style.cssText = 'width:56px;height:56px;object-fit:cover;background:#2d0040;flex:none'; img.alt = ''; if (p.thumb_url) img.src = p.thumb_url;
        const info = document.createElement('div'); info.style.flex = '1';
        const t = document.createElement('div'); t.textContent = p.title || '(제목 없음)'; t.style.fontWeight = '700';
        const m = document.createElement('div'); m.textContent = new Date(p.updated_at).toLocaleString('ko-KR'); m.style.cssText = 'font-size:.78rem;color:#a79aa8';
        info.append(t, m);
        const b = document.createElement('button'); b.textContent = '열기'; b.style.cssText = 'padding:8px 14px;font-weight:700;cursor:pointer;flex:none';
        b.onclick = () => openProject(p.id);
        row.append(img, info, b); list.appendChild(row);
      });
    } catch (e) { list.textContent = '목록을 불러오지 못했어요.'; }
  }

  // 초기화(clearDraw) 직후 그림판이 새 상태면 계정 작업과의 연결을 끊어서, 빈 화면이 저장본을 덮어쓰지 않게 함
  function guardClearDraw() {
    if (typeof window.clearDraw !== 'function') return;
    const orig = window.clearDraw;
    window.clearDraw = function () {
      const r = orig.apply(this, arguments);
      const fresh = drawLayers.length <= 2 && drawLayers.every(l => !l.history || l.history.length === 0);
      if (cur && fresh) unbind('초기화해서 계정 작업과의 연결을 해제했어요');
      return r;
    };
  }

  // 편집이 있으면 동기화 예약 (기존 자동 저장과 같은 이벤트 사용)
  function watchEdits() {
    const touch = () => {
      if (!cur) return;
      const p = $('panel-draw');
      if (p && p.classList.contains('active')) cur.syncer.touch();
    };
    ['pointerup', 'keyup', 'change', 'input'].forEach(t => document.addEventListener(t, touch, true));
  }

  function showButtons() {
    ['btnCloudSave', 'btnCloudOpen', 'cloudStatus'].forEach(id => { const el = $(id); if (el) el.style.display = ''; });
  }

  async function init() {
    // 로그인 흔적이 있을 때만 로그인 모듈(supabase-js)을 불러옴 → 로그인하지 않은 사용자에게는 추가 로딩 없음
    let hinted = false;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) { hinted = true; break; } } } catch (e) {}
    if (!hinted) return;
    let session = null;
    try { session = await BoldAuth.session(); } catch (e) {}
    if (!session) return;

    showButtons();
    $('btnCloudSave').onclick = saveClick;
    $('btnCloudOpen').onclick = openListClick;
    guardClearDraw();
    watchEdits();

    const openId = QS.get('open');
    if ((QS.get('kind') || 'draw') === 'draw' && openId && UUID.test(openId)) {
      history.replaceState(null, '', location.pathname);
      openProject(openId, { skipConfirm: true });
    }
  }

  window.DrawCloud = { open: openProject };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
