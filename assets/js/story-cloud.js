// 스토리 만들기 ↔ 계정 저장 어댑터. auth-client.js, cloud-save.js 다음에 불러온다.
// 작품 객체 안의 큰 이미지(data:image/...)를 파일로 따로 올리고 객체에는 파일 id 만 남긴다. 불러올 때는 되돌려서
// 기존 stRestoreProj 로 검증·복원하므로 도구 내부 코드는 수정하지 않는다. 로그인한 사용자에게만 버튼을 보여 준다.
(function () {
  const QS = new URLSearchParams(location.search);   // 다른 스크립트가 주소를 바꾸기 전에 읽어 둠
  const $ = id => document.getElementById(id);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const OK_MIME = /^data:(image\/(?:png|jpeg|webp|gif));base64,/;
  const SKIP_KEYS = { busy: 1, charBusy: 1 };          // 화면 진행 표시용 값은 저장하지 않음 (작업 파일과 동일)
  const LAST_KEY = 'bold_cloud_story_last';
  let cur = null;                                       // { id, mode, title, obj, syncer, known:Map, prevRefs:Set }

  function setStatus(text, kind) {
    const el = $('stCloudStatus'); if (!el) return;
    el.textContent = text || '';
    el.style.color = kind === 'err' ? '#c62837' : kind === 'ok' ? '#1a8f4d' : '#6b6478';
  }
  const remember = (id, title) => { try { localStorage.setItem(LAST_KEY, JSON.stringify({ id, title })); } catch (e) {} };
  const lastBound = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { return null; } };
  const today = () => new Date().toISOString().slice(0, 10);

  async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }
  function blobToDataUrl(b) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
  }

  // 작품 → 저장용 객체 (data:image 를 {$asset:id} 로 치환). state 는 {known, prevRefs, refs, progress}
  async function pack(value, projectId, st) {
    if (typeof value === 'string') {
      if (!value.startsWith('data:')) return value;
      const m = OK_MIME.exec(value);
      if (!m) return '';                                  // 지원하지 않는 형식은 저장하지 않음
      const hit = st.known.get(value);
      if (hit && st.prevRefs.has(hit)) { st.refs.add(hit); return { $asset: hit }; }  // 지난 저장에서 쓰던 같은 이미지는 다시 올리지 않음
      const blob = await dataUrlToBlob(value);
      const id = await CloudSave.uploadAsset(projectId, new Blob([blob], { type: m[1] }));
      st.known.set(value, id); st.refs.add(id); st.done++;
      if (st.onProgress) st.onProgress(st.done);
      return { $asset: id };
    }
    if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await pack(v, projectId, st)); return out; }
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) { if (SKIP_KEYS[k]) continue; out[k] = await pack(value[k], projectId, st); }
      return out;
    }
    return value;
  }

  // 저장용 객체 → 작품 (파일을 내려받아 data:image 로 되돌림)
  async function unpack(value, assets, st) {
    if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await unpack(v, assets, st)); return out; }
    if (value && typeof value === 'object') {
      if (typeof value.$asset === 'string') {
        const a = assets[value.$asset];
        st.n++; if (st.onProgress) st.onProgress(st.n, st.total);
        if (!a) return '';                                // 파일이 없으면 빈 이미지로 둠 (앱이 깨지지 않게)
        try {
          const res = await fetch(a.url);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return await blobToDataUrl(await res.blob());
        } catch (e) { console.warn('이미지 불러오기 실패(빈 이미지로 유지):', e); return ''; }
      }
      const out = {};
      for (const k of Object.keys(value)) out[k] = await unpack(value[k], assets, st);
      return out;
    }
    return value;
  }
  const countAssets = v => Array.isArray(v) ? v.reduce((n, x) => n + countAssets(x), 0)
    : (v && typeof v === 'object') ? (typeof v.$asset === 'string' ? 1 : Object.values(v).reduce((n, x) => n + countAssets(x), 0)) : 0;

  async function buildState() {
    const proj = stS.proj[cur.mode];
    if (proj !== cur.obj) throw Object.assign(new Error('replaced'), { replaced: true });  // 작품이 통째로 바뀌었으면 덮어쓰지 않음
    const st = { known: cur.known, prevRefs: cur.prevRefs, refs: new Set(), done: 0,
      onProgress: n => setStatus('이미지 올리는 중... ' + n + '장') };
    const packed = await pack(proj, cur.id, st);
    cur.pendingRefs = st.refs;
    return { data: { v: 1, mode: cur.mode, proj: packed } };
  }

  function bind(id, mode, title, version) {
    if (cur && cur.syncer) cur.syncer.stop();
    const obj = stS.proj[mode];
    const syncer = CloudSave.syncer({
      projectId: id, version, debounceMs: 8000, minIntervalMs: 30000,
      getState: async () => {
        try { return await buildState(); }
        catch (e) {
          if (e && e.replaced) { unbind('작품이 바뀌어서 계정 작업과의 연결을 해제했어요'); throw Object.assign(new Error('replaced'), { stopSync: true }); }
          throw e;
        }
      },
      onStatus: (s, text) => {
        if (s === 'saved' && cur) { cur.prevRefs = cur.pendingRefs || cur.prevRefs; }
        setStatus(s === 'saved' ? '☁ ' + text : text, s === 'saved' ? 'ok' : (s === 'error' || s === 'conflict') ? 'err' : '');
      },
      onConflict: () => resolveConflict(),
    });
    cur = { id, mode, title, obj, syncer, known: new Map(), prevRefs: new Set(), pendingRefs: null };
    remember(id, title);
    const btn = $('btnStCloudSave'); if (btn) btn.textContent = '☁ 저장됨: ' + (title.length > 8 ? title.slice(0, 8) + '…' : title);
  }
  function unbind(msg) {
    if (cur && cur.syncer) cur.syncer.stop();
    cur = null;
    const btn = $('btnStCloudSave'); if (btn) btn.textContent = '☁ 계정에 저장';
    if (msg) setStatus(msg);
  }

  async function resolveConflict() {
    const id = cur.id, mode = cur.mode, title = cur.title;
    if (confirm('다른 기기(또는 다른 창)에서 이 작품이 먼저 저장되었어요.\n\n[확인] 지금 화면 내용으로 덮어쓰기 (이전 내용은 버전으로 보관돼요)\n[취소] 다른 방법 고르기')) {
      try { const d = await CloudSave.open(id); cur.syncer.setVersion(d.project.version); cur.syncer.flush(); } catch (e) { setStatus('저장 실패 · 다시 시도해 주세요', 'err'); }
      return;
    }
    if (confirm('서버에 저장된 작품을 불러올까요?\n(지금 화면의 작품은 바뀌어요)\n\n[확인] 서버 작품 불러오기\n[취소] 지금 작품을 새 작업(복사본)으로 저장')) { openProject(id, { skipConfirm: true }); return; }
    try {
      const p = await CloudSave.create('story', title + ' (복사본)', {});
      bind(p.id, mode, p.title || title + ' (복사본)', p.version);
      cur.syncer.flush();
    } catch (e) { setStatus('복사본을 만들지 못했어요', 'err'); }
  }

  async function saveClick() {
    const btn = $('btnStCloudSave');
    try {
      if (!stS.loaded) await (stS.loading || (stS.loading = stLoad()));
      // 작품이 통째로 바뀌었으면(새로 시작·작업 파일 불러오기) 이전 연결은 끊음
      if (cur && stS.proj[cur.mode] !== cur.obj) unbind();
      if (cur) { btn.disabled = true; await cur.syncer.flush(); return; }
      const mode = stS.cur;
      const last = lastBound();
      if (last && UUID.test(last.id || '')) {
        if (confirm('"' + (last.title || '이전 작품') + '"에 이어서 저장할까요?\n(그 작업의 내용이 지금 작품으로 바뀌어요. 이전 내용은 버전으로 보관돼요.)\n\n[취소]를 누르면 새 작업으로 저장해요.')) {
          try {
            const d = await CloudSave.open(last.id);
            if (!d.project.deleted_at && d.project.data && d.project.data.mode === mode) { btn.disabled = true; bind(last.id, mode, d.project.title || last.title, d.project.version); await cur.syncer.flush(); return; }
          } catch (e) { /* 없어졌거나 모드가 다르면 새 작업으로 */ }
        }
      }
      const p0 = stS.proj[mode];
      const title = prompt('작업 이름을 정해 주세요', (p0.title || '나의 그림책') + ' ' + today());
      if (title == null) return;
      btn.disabled = true;
      const p = await CloudSave.create('story', title.trim() || '나의 그림책 ' + today(), {});
      bind(p.id, mode, p.title, p.version);
      await cur.syncer.flush();
    } catch (e) {
      setStatus(e.message === 'quota_exceeded' ? '저장 공간이 가득 찼어요 · 마이페이지에서 정리해 주세요' : '저장 실패 · 다시 시도해 주세요', 'err');
    } finally { btn.disabled = false; }
  }

  function ensureStoryMode() {
    return new Promise(resolve => {
      const panel = $('panel-story');
      if (panel && !panel.classList.contains('active')) {
        const tab = document.querySelector('.mode-tab[onclick*="\'story\'"]');
        if (typeof switchMode === 'function') switchMode('story', tab);
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  async function openProject(id, opts) {
    opts = opts || {};
    try {
      setStatus('불러오는 중...');
      const d = await CloudSave.open(id);
      const data = d.project.data;
      if (!data || data.v !== 1 || !data.proj || (data.mode !== 'short' && data.mode !== 'long')) throw new Error('이 작업은 스토리 만들기에서 열 수 없어요.');
      if (!opts.skipConfirm && !confirm('지금 ' + (data.mode === 'long' ? '장편' : '단편') + ' 작품이 이 작업의 내용으로 바뀌어요.\n계속할까요?')) { setStatus(''); return; }
      await ensureStoryMode();
      if (!stS.loaded) await (stS.loading || (stS.loading = stLoad()));

      const total = countAssets(data.proj);
      const raw = await unpack(data.proj, d.assets || {}, { n: 0, total, onProgress: (n, t) => setStatus('이미지 불러오는 중... ' + n + '/' + t) });
      const mode = data.mode;
      stS.proj[mode] = stRestoreProj(mode, raw);        // 기존 검증 함수로 복원
      stS.cur = mode; stS.trash = null; stS.hints = {};
      storyRenderAll(); stSave();
      bind(id, mode, d.project.title || '', d.project.version);
      setStatus('☁ 불러왔어요', 'ok');
      const m = $('cloudStoryModal'); if (m) m.remove();
    } catch (e) {
      setStatus('불러오기 실패: ' + (e.message === 'not_found' ? '작업을 찾을 수 없어요' : e.message), 'err');
    }
  }

  async function openListClick() {
    const old = $('cloudStoryModal'); if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'cloudStoryModal';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#222;border:2px solid #333;max-width:480px;width:100%;max-height:80vh;overflow:auto;padding:18px;border-radius:10px';
    const h = document.createElement('div'); h.textContent = '☁ 내 스토리 작업 열기'; h.style.cssText = 'font-weight:800;font-size:1.1rem;margin-bottom:12px';
    const list = document.createElement('div'); list.textContent = '불러오는 중...';
    const close = document.createElement('button'); close.textContent = '닫기'; close.style.cssText = 'margin-top:12px;padding:10px 16px;font-weight:700;cursor:pointer';
    close.onclick = () => ov.remove();
    ov.onclick = e => { if (e.target === ov) ov.remove(); };
    box.append(h, list, close); ov.appendChild(box); document.body.appendChild(ov);
    try {
      const d = await CloudSave.list({ kind: 'story' });
      list.innerHTML = '';
      if (!d.projects.length) { list.textContent = '저장된 작업이 없어요. "☁ 계정에 저장"으로 먼저 저장해 보세요.'; return; }
      d.projects.forEach(p => {
        const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;align-items:center;margin-bottom:10px';
        const info = document.createElement('div'); info.style.flex = '1';
        const t = document.createElement('div'); t.textContent = p.title || '(제목 없음)'; t.style.fontWeight = '700';
        const m = document.createElement('div'); m.textContent = new Date(p.updated_at).toLocaleString('ko-KR') + ' · ' + (p.size_bytes / 1024).toFixed(0) + 'KB'; m.style.cssText = 'font-size:.78rem;color:#777';
        info.append(t, m);
        const b = document.createElement('button'); b.textContent = '열기'; b.style.cssText = 'padding:8px 14px;font-weight:700;cursor:pointer;flex:none';
        b.onclick = () => { if (confirm('지금 작품이 이 작업의 내용으로 바뀌어요. 계속할까요?')) openProject(p.id, { skipConfirm: true }); };
        row.append(info, b); list.appendChild(row);
      });
    } catch (e) { list.textContent = '목록을 불러오지 못했어요.'; }
  }

  // 편집이 있을 때마다 동기화 예약: 기존 자동 저장 함수(stSave)에 연결
  function hookStSave() {
    if (typeof window.stSave !== 'function') return;
    const orig = window.stSave;
    window.stSave = function () {
      const r = orig.apply(this, arguments);
      if (cur) {
        if (stS.proj[cur.mode] !== cur.obj) unbind('작품이 바뀌어서 계정 작업과의 연결을 해제했어요');
        else cur.syncer.touch();
      }
      return r;
    };
  }

  async function init() {
    let hinted = false;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) { hinted = true; break; } } } catch (e) {}
    if (!hinted) return;
    let session = null;
    try { session = await BoldAuth.session(); } catch (e) {}
    if (!session) return;

    ['btnStCloudSave', 'btnStCloudOpen', 'stCloudStatus'].forEach(id => { const el = $(id); if (el) el.style.display = ''; });
    $('btnStCloudSave').onclick = saveClick;
    $('btnStCloudOpen').onclick = openListClick;
    hookStSave();

    const openId = QS.get('open');
    if (QS.get('kind') === 'story' && openId && UUID.test(openId)) {
      history.replaceState(null, '', location.pathname);
      openProject(openId, { skipConfirm: true });
    }
  }

  window.StoryCloud = { open: openProject, _pack: pack, _unpack: unpack, get bound() { return cur ? { id: cur.id, title: cur.title, mode: cur.mode } : null; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
