// 도구 ↔ 계정 저장 공통 연결기 (window.CloudTool). auth-client.js, cloud-save.js 다음에 불러온다.
// 캐릭터 꾸미기·스토리보드·그림책 더빙 어댑터가 함께 쓴다. 저장 버튼 흐름, 이어서 저장, 충돌 처리,
// 목록 열기, 주소(?open=&kind=)로 열기를 한 곳에서 처리하고, 도구별 파일은 "상태 만들기/되돌리기"만 맡는다.
// 규칙(2-B·2-C와 동일): 새로고침 뒤 자동 재연결 안 함, 작품이 바뀌면 연결 해제, 충돌(409)은 덮어쓰기·불러오기·복사본 선택.
(function () {
  const QS = new URLSearchParams(location.search);   // 다른 스크립트가 주소를 바꾸기 전에 읽어 둠
  const $ = id => document.getElementById(id);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const today = () => new Date().toISOString().slice(0, 10);
  const ERR = {
    quota_exceeded: '저장 공간이 가득 찼어요 · 마이페이지에서 정리해 주세요',
    project_limit: '작업 개수가 너무 많아요 · 마이페이지에서 정리해 주세요',
    payload_too_large: '작업 내용이 너무 커요',
  };

  function hasSessionHint() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) return true; } } catch (e) {}
    return false;
  }

  function attach(cfg) {
    const LAST_KEY = 'bold_cloud_' + cfg.kind + '_last';
    let cur = null;   // { id, title, syncer, cache:Map, prevRefs:Set, pendingRefs, meta }
    let urlConsumed = false;

    function setStatus(text, kind) {
      const el = $(cfg.ids.status); if (!el) return;
      el.textContent = text || '';
      const c = cfg.colors || { err: '#c62837', ok: '#1a8f4d', info: '#6b6478' };
      el.style.color = kind === 'err' ? c.err : kind === 'ok' ? c.ok : c.info;
    }
    const remember = (id, title) => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ id, title })); } catch (e) {} };
    const lastBound = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { return null; } };
    const errText = e => ERR[e && e.message] || '저장 실패 · 다시 시도해 주세요';

    // 도구가 파일을 올릴 때 쓰는 도우미. key 가 같고 지난 저장에서 쓰던 파일이면 다시 올리지 않는다
    // (지난 저장에서 참조되지 않은 파일은 서버 정리로 지워졌을 수 있어 다시 올림)
    function makeCtx() {
      const refs = new Set();
      let uploaded = 0;
      return {
        projectId: cur.id,
        meta: cur.meta,
        refs,
        async upload(blob, key) {
          if (key != null) {
            const hit = cur.cache.get(key);
            if (hit && cur.prevRefs.has(hit)) { refs.add(hit); return hit; }
          }
          const id = await CloudSave.uploadAsset(cur.id, blob);
          if (key != null) cur.cache.set(key, id);
          refs.add(id); uploaded++;
          setStatus('파일 올리는 중... ' + uploaded + '개');
          return id;
        },
      };
    }

    async function buildState() {
      if (cfg.isStale && cfg.isStale(cur.meta)) throw Object.assign(new Error('replaced'), { replaced: true });
      const ctx = makeCtx();
      const st = await cfg.buildState(ctx);
      cur.pendingRefs = ctx.refs;
      if (st.thumbAsset) ctx.refs.add(st.thumbAsset);
      return st;
    }

    function bind(id, title, version, meta) {
      if (cur && cur.syncer) cur.syncer.stop();
      cur = { id, title, cache: new Map(), prevRefs: new Set(), pendingRefs: null, meta: meta || {} };
      cur.syncer = CloudSave.syncer({
        projectId: id, version, debounceMs: cfg.debounceMs || 6000, minIntervalMs: cfg.minIntervalMs || 20000,
        getState: async () => {
          try { return await buildState(); }
          catch (e) {
            if (e && e.replaced) { unbind('작품이 바뀌어서 계정 작업과의 연결을 해제했어요'); throw Object.assign(new Error('replaced'), { stopSync: true }); }
            throw e;
          }
        },
        onStatus: (s, text) => {
          if (s === 'saved' && cur) cur.prevRefs = cur.pendingRefs || cur.prevRefs;
          if (s === 'saved' && cfg.afterSave) cfg.afterSave();
          setStatus(s === 'saved' ? '☁ ' + text : text, s === 'saved' ? 'ok' : (s === 'error' || s === 'conflict') ? 'err' : '');
        },
        onConflict: () => resolveConflict(),
      });
      remember(id, title);
      const btn = $(cfg.ids.save); if (btn) btn.textContent = '☁ 저장됨: ' + (title.length > 8 ? title.slice(0, 8) + '…' : title);
      if (cfg.onBind) cfg.onBind(cur.meta);
    }
    function unbind(msg) {
      if (cur && cur.syncer) cur.syncer.stop();
      cur = null;
      const btn = $(cfg.ids.save); if (btn) btn.textContent = '☁ 계정에 저장';
      if (msg) setStatus(msg);
    }

    async function resolveConflict() {
      const id = cur.id, title = cur.title, meta = cur.meta;
      if (confirm('다른 기기(또는 다른 창)에서 이 작업이 먼저 저장되었어요.\n\n[확인] 지금 화면 내용으로 덮어쓰기 (이전 내용은 버전으로 보관돼요)\n[취소] 다른 방법 고르기')) {
        try { const d = await CloudSave.open(id); cur.syncer.setVersion(d.project.version); cur.syncer.flush(); } catch (e) { setStatus('저장 실패 · 다시 시도해 주세요', 'err'); }
        return;
      }
      if (confirm('서버에 저장된 작업을 불러올까요?\n(지금 화면 내용은 바뀌어요)\n\n[확인] 서버 작업 불러오기\n[취소] 지금 화면을 새 작업(복사본)으로 저장')) { openProject(id, { skipConfirm: true }); return; }
      try {
        const p = await CloudSave.create(cfg.kind, title + ' (복사본)', {});
        bind(p.id, p.title || title + ' (복사본)', p.version, meta);
        cur.syncer.flush();
      } catch (e) { setStatus('복사본을 만들지 못했어요', 'err'); }
    }

    async function saveClick() {
      const btn = $(cfg.ids.save);
      try {
        if (cfg.ready) await cfg.ready();
        if (cur && cfg.isStale && cfg.isStale(cur.meta)) unbind();
        if (cur && cfg.matchesCurrent && !cfg.matchesCurrent(cur.meta)) unbind();   // 다른 작품으로 옮겨 와서 누른 경우 → 지금 작품을 새로 저장
        if (cur) { btn.disabled = true; await cur.syncer.flush(); return; }
        const meta = cfg.currentMeta ? cfg.currentMeta() : {};
        if (meta === null) return;                       // 도구가 "지금은 저장할 것이 없다"고 알림 (안내는 도구가 함)
        const last = lastBound();
        if (last && UUID.test(last.id || '')) {
          if (confirm('"' + (last.title || '이전 작업') + '"에 이어서 저장할까요?\n(그 작업의 내용이 지금 화면으로 바뀌어요. 이전 내용은 버전으로 보관돼요.)\n\n[취소]를 누르면 새 작업으로 저장해요.')) {
            try {
              const d = await CloudSave.open(last.id);
              if (!d.project.deleted_at && (!cfg.canContinue || cfg.canContinue(d.project.data, meta))) {
                btn.disabled = true; bind(last.id, d.project.title || last.title, d.project.version, meta); await cur.syncer.flush(); return;
              }
            } catch (e) { /* 없어졌거나 종류가 다르면 새 작업으로 */ }
          }
        }
        const title = prompt('작업 이름을 정해 주세요', cfg.defaultTitle(meta) + ' ' + today());
        if (title == null) return;
        btn.disabled = true;
        const p = await CloudSave.create(cfg.kind, title.trim() || cfg.defaultTitle(meta) + ' ' + today(), {});
        bind(p.id, p.title, p.version, meta);
        await cur.syncer.flush();
      } catch (e) {
        setStatus(errText(e), 'err');
      } finally { btn.disabled = false; }
    }

    async function openProject(id, opts) {
      opts = opts || {};
      try {
        setStatus('불러오는 중...');
        const d = await CloudSave.open(id);
        const data = d.project.data;
        if (!cfg.validate(data)) throw new Error('이 작업은 여기에서 열 수 없어요.');
        if (!opts.skipConfirm && !confirm(cfg.confirmOpenText || '지금 화면이 이 작업의 내용으로 바뀌어요.\n계속할까요?')) { setStatus(''); return; }
        if (cur) unbind();
        if (cfg.ensureMode) await cfg.ensureMode();
        if (cfg.ready) await cfg.ready();
        const meta = await cfg.apply(data, d.assets || {}, {
          progress: (n, t) => setStatus('파일 불러오는 중... ' + n + '/' + t),
        });
        bind(id, d.project.title || '', d.project.version, meta || {});
        setStatus('☁ 불러왔어요', 'ok');
        const m = $('cloudToolModal'); if (m) m.remove();
      } catch (e) {
        setStatus('불러오기 실패: ' + (e.message === 'not_found' ? '작업을 찾을 수 없어요' : e.message), 'err');
      }
    }

    async function openListClick() {
      const old = $('cloudToolModal'); if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'cloudToolModal';
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#222;border:2px solid #333;max-width:480px;width:100%;max-height:80vh;overflow:auto;padding:18px;border-radius:10px';
      const h = document.createElement('div'); h.textContent = '☁ 내 ' + cfg.label + ' 작업 열기'; h.style.cssText = 'font-weight:800;font-size:1.1rem;margin-bottom:12px';
      const list = document.createElement('div'); list.textContent = '불러오는 중...';
      const close = document.createElement('button'); close.textContent = '닫기'; close.style.cssText = 'margin-top:12px;padding:10px 16px;font-weight:700;cursor:pointer';
      close.onclick = () => ov.remove();
      ov.onclick = e => { if (e.target === ov) ov.remove(); };
      box.append(h, list, close); ov.appendChild(box); document.body.appendChild(ov);
      try {
        const d = await CloudSave.list({ kind: cfg.kind });
        list.innerHTML = '';
        if (!d.projects.length) { list.textContent = '저장된 작업이 없어요. "☁ 계정에 저장"으로 먼저 저장해 보세요.'; return; }
        d.projects.forEach(p => {
          const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:10px';
          if (p.thumb_url) {
            const im = document.createElement('img'); im.src = p.thumb_url; im.alt = '';
            im.style.cssText = 'width:48px;height:48px;object-fit:cover;flex:none;border:1px solid #ddd';
            row.appendChild(im);
          }
          const info = document.createElement('div'); info.style.flex = '1';
          const t = document.createElement('div'); t.textContent = p.title || '(제목 없음)'; t.style.fontWeight = '700';
          const m = document.createElement('div'); m.textContent = new Date(p.updated_at).toLocaleString('ko-KR') + ' · ' + (p.size_bytes / 1024).toFixed(0) + 'KB'; m.style.cssText = 'font-size:.78rem;color:#777';
          info.append(t, m);
          const b = document.createElement('button'); b.textContent = '열기'; b.style.cssText = 'padding:8px 14px;font-weight:700;cursor:pointer;flex:none';
          b.onclick = () => { if (confirm(cfg.confirmOpenText || '지금 화면이 이 작업의 내용으로 바뀌어요. 계속할까요?')) openProject(p.id, { skipConfirm: true }); };
          row.append(info, b); list.appendChild(row);
        });
      } catch (e) { list.textContent = '목록을 불러오지 못했어요.'; }
    }

    // 도구가 편집이 있을 때 부른다
    function touch() {
      if (!cur) return;
      if (cfg.isStale && cfg.isStale(cur.meta)) { unbind('작품이 바뀌어서 계정 작업과의 연결을 해제했어요'); return; }
      cur.syncer.touch();
    }

    async function init() {
      if (!hasSessionHint()) return;
      let session = null;
      try { session = await BoldAuth.session(); } catch (e) {}
      if (!session) return;
      [cfg.ids.save, cfg.ids.open, cfg.ids.status].forEach(id => { const el = $(id); if (el) el.style.display = ''; });
      $(cfg.ids.save).onclick = saveClick;
      $(cfg.ids.open).onclick = openListClick;
      if (cfg.watch) cfg.watch(touch);

      const openId = QS.get('open');
      if (!urlConsumed && QS.get('kind') === cfg.kind && openId && UUID.test(openId)) {
        urlConsumed = true;
        history.replaceState(null, '', location.pathname);
        openProject(openId, { skipConfirm: true });
      }
    }

    const handle = {
      touch, unbind, open: openProject, setStatus,
      get bound() { return cur ? { id: cur.id, title: cur.title, meta: cur.meta } : null; },
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
    return handle;
  }

  // 공통 도우미
  const util = {
    UUID,
    async dataUrlToBlob(u) { return (await fetch(u)).blob(); },
    blobToDataUrl(b) {
      return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
    },
    async fetchAsset(assets, id) {
      const a = id && assets[id];
      if (!a) return null;
      const res = await fetch(a.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    },
    canvasToBlob(canvas, type, q) { return new Promise(r => { try { canvas.toBlob(r, type, q); } catch (e) { r(null); } }); },
    // 큰 사진을 저장용으로 줄임 (긴 변 max px, JPEG). 투명 배경이 필요한 PNG 는 png=true
    async shrinkImage(src, max, png) {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const s = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
      const x = c.getContext('2d');
      if (!png) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
      x.drawImage(img, 0, 0, c.width, c.height);
      return util.canvasToBlob(c, png ? 'image/png' : 'image/jpeg', 0.85);
    },
    // 썸네일: 캔버스를 긴 변 320px JPEG 로
    async thumbFromCanvas(canvas) {
      if (!canvas || !canvas.width) return null;
      const s = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(canvas.width * s)); c.height = Math.max(1, Math.round(canvas.height * s));
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      try { x.drawImage(canvas, 0, 0, c.width, c.height); } catch (e) { return null; }
      return util.canvasToBlob(c, 'image/jpeg', 0.8);   // 외부 그림 때문에 캔버스가 막히면 null (썸네일 없이 저장)
    },
    waitFor(test, timeoutMs) {
      return new Promise(resolve => {
        const t0 = Date.now();
        (function loop() { if (test() || Date.now() - t0 > (timeoutMs || 10000)) resolve(); else setTimeout(loop, 100); })();
      });
    },
    switchTo(mode) {
      return new Promise(resolve => {
        const panel = $('panel-' + mode);
        if (panel && !panel.classList.contains('active')) {
          const tab = document.querySelector('.mode-tab[onclick*="\'' + mode + '\'"]');
          if (typeof switchMode === 'function' && tab) switchMode(mode, tab);
        }
        setTimeout(resolve, 120);   // 도구 초기화(50ms 지연) 이후. 화면이 가려진 탭에서도 멈추지 않게 타이머만 사용
      });
    },
  };

  window.CloudTool = { attach, util };
})();
