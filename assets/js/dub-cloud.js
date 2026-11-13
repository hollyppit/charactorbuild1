// 그림책 더빙 ↔ 계정 저장 어댑터. cloud-tool.js 다음에 불러온다.
// - 직접 만든 작품: 장면(이름·글·글자 모양)과 사진·동영상·녹음을 모두 저장한다.
// - 기본 작품 더빙: 기본 작품 id 와 내 녹음만 저장한다(그림은 기본 작품 것을 그대로 씀).
// 파일당 10MB 를 넘는 동영상·녹음은 저장하지 않고 한 번 알려 준다. 도구 코드는 수정하지 않는다.
(function () {
  if (!window.CloudTool) return;
  const U = CloudTool.util;
  const $ = id => document.getElementById(id);
  const MAX = 10 * 1024 * 1024;
  const IMG = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const VID = ['video/mp4', 'video/webm', 'video/quicktime'];
  const AUD = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
  const warned = new WeakSet();
  let lastSig = null;
  let tool = null;

  const baseType = t => String(t || '').split(';')[0].trim().toLowerCase();
  const ids = new WeakMap(); let idSeq = 0;
  const objId = o => { if (!o) return 0; if (typeof o !== 'object') return String(o); if (!ids.has(o)) ids.set(o, ++idSeq); return ids.get(o); };

  function currentProject() {
    const id = dubCurrentProjectId;
    if (id == null) return null;
    const personal = dubPersonalProjects.find(p => p.id === id);
    if (personal) return { proj: personal, source: 'personal', baseId: null };
    const base = dubProjects.find(p => p.id === id);
    if (base) return { proj: base, source: 'base', baseId: String(base.id) };
    return null;
  }

  function sigOf(meta) {
    const p = meta && meta.proj; if (!p) return '';
    try {
      return JSON.stringify([p.title, p.scenes.map(s => [s.id, s.name, s.text, s.textStyle, objId(s.mediaBlob || s.mediaObjectURL), objId(s.audioBlob)])]);
    } catch (e) { return ''; }
  }

  function warnOnce(blob, msg) {
    if (!blob || typeof blob !== 'object' || warned.has(blob)) return;
    warned.add(blob);
    setTimeout(() => alert(msg), 0);
  }

  // 장면 사진·동영상 → 저장용 Blob (형식·크기 맞춤). 저장할 수 없으면 null
  async function mediaBlob(sc) {
    let blob = sc.mediaBlob;
    if (!blob && sc.mediaObjectURL) {
      try { const r = await fetch(sc.mediaObjectURL); if (!r.ok) return null; blob = await r.blob(); } catch (e) { return null; }
    }
    if (!blob) return null;
    const t = baseType(blob.type);
    if (sc.mediaType === 'video' || t.startsWith('video/')) {
      if (!VID.includes(t)) { warnOnce(sc.mediaBlob, '"' + (sc.name || '장면') + '"의 동영상 형식은 계정에 저장할 수 없어요. (mp4·webm·mov만 가능)'); return null; }
      if (blob.size > MAX) { warnOnce(sc.mediaBlob, '"' + (sc.name || '장면') + '"의 동영상이 10MB보다 커서 계정에 저장하지 못했어요.\n(장면 글과 녹음은 저장돼요)'); return null; }
      return t === blob.type ? blob : new Blob([blob], { type: t });
    }
    if (IMG.includes(t) && blob.size <= MAX) return t === blob.type ? blob : new Blob([blob], { type: t });
    const u = URL.createObjectURL(blob);                       // 큰 사진·다른 형식은 줄여서 JPEG 로
    try { return await U.shrinkImage(u, 2400); } catch (e) { return null; } finally { URL.revokeObjectURL(u); }
  }

  function audioBlob(sc) {
    const blob = sc.audioBlob; if (!blob) return null;
    const t = baseType(blob.type) || 'audio/webm';
    if (!AUD.includes(t)) { warnOnce(blob, '"' + (sc.name || '장면') + '"의 녹음 형식은 계정에 저장할 수 없어요.'); return null; }
    if (blob.size > MAX) { warnOnce(blob, '"' + (sc.name || '장면') + '"의 녹음이 10MB보다 길어서 계정에 저장하지 못했어요.'); return null; }
    return t === blob.type ? blob : new Blob([blob], { type: t });
  }

  async function thumbFor(scenes) {
    for (const sc of scenes) {
      if (sc.mediaType === 'video' || !sc.mediaObjectURL) continue;
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = sc.mediaObjectURL; });
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const b = await U.thumbFromCanvas(c);
        if (b) return b;
      } catch (e) { /* 다음 장면으로 */ }
    }
    return null;
  }

  async function buildState(ctx) {
    const meta = ctx.meta, p = meta.proj;
    const scenes = [];
    for (const sc of p.scenes) {
      const o = { ref: String(sc.id), name: String(sc.name || ''), text: String(sc.text || ''), textStyle: sc.textStyle || null };
      if (meta.source === 'personal') {
        o.mediaType = sc.mediaType === 'video' ? 'video' : sc.mediaType === 'image' ? 'image' : null;
        o.media = null;
        if (sc.mediaBlob || sc.mediaObjectURL) {
          const b = await mediaBlob(sc);
          if (b) o.media = await ctx.upload(b, sc.mediaBlob || sc.mediaObjectURL);
        }
      }
      o.audio = null;
      const a = audioBlob(sc);
      if (a) o.audio = await ctx.upload(a, sc.audioBlob);
      if (meta.source === 'base' && !o.audio) continue;           // 기본 작품은 녹음한 장면만
      if (meta.source === 'base') { delete o.name; delete o.text; delete o.textStyle; }
      scenes.push(o);
    }
    const tb = await thumbFor(p.scenes);
    const thumbAsset = tb ? await ctx.upload(tb) : undefined;
    return {
      data: { v: 1, source: meta.source, baseId: meta.baseId || null, title: String(p.title || ''), scenes },
      thumbAsset,
    };
  }

  function setAudio(sc, blob) {
    if (sc.audioObjectURL) URL.revokeObjectURL(sc.audioObjectURL);
    sc.audioBlob = blob || null;
    sc.audioObjectURL = blob ? URL.createObjectURL(blob) : null;
  }

  async function apply(data, files, ui) {
    if (typeof initDubPanel === 'function' && dubProjects.length === 0) { try { await dubLoadFromDB(); } catch (e) {} }
    const total = data.scenes.reduce((n, s) => n + (s && s.media ? 1 : 0) + (s && s.audio ? 1 : 0), 0);
    let n = 0;
    const get = async id => {
      if (!id) return null;
      try { return await U.fetchAsset(files, id); }
      catch (e) { console.warn('파일 불러오기 실패:', e); return null; }
      finally { n++; ui.progress(n, total); }
    };
    if (typeof switchDubStep === 'function') switchDubStep(0);

    if (data.source === 'base') {
      const base = dubProjects.find(p => String(p.id) === String(data.baseId));
      if (!base) throw new Error('이 더빙의 기본 작품이 지금은 없어요.');
      const byRef = new Map(data.scenes.filter(Boolean).map(s => [String(s.ref), s]));
      let missing = 0;
      for (const s of byRef.values()) if (!base.scenes.some(x => String(x.id) === s.ref)) missing++;
      for (const sc of base.scenes) {
        const s = byRef.get(String(sc.id));
        setAudio(sc, s && s.audio ? await get(s.audio) : null);
      }
      if (typeof dubSwitchProjTab === 'function' && !isAdmin) dubSwitchProjTab(0);
      dubSelectProject(base.id);
      if (missing) setTimeout(() => alert('기본 작품에서 없어진 장면 ' + missing + '개의 녹음은 불러오지 못했어요.'), 0);
      return { proj: base, source: 'base', baseId: String(base.id) };
    }

    const proj = { id: 'p' + Date.now(), title: String(data.title || '').slice(0, 40), scenes: [] };
    for (const s of data.scenes) {
      if (!s) continue;
      const sc = {
        id: Date.now() + Math.random(),
        name: String(s.name || '').slice(0, 60), text: String(s.text || '').slice(0, 2000),
        mediaBlob: null, mediaType: null, mediaObjectURL: null, audioBlob: null, audioObjectURL: null,
        textStyle: Object.assign({}, DUB_DEFAULT_STYLE, s.textStyle && typeof s.textStyle === 'object' ? s.textStyle : {}),
      };
      const mb = await get(s.media);
      if (mb) { sc.mediaBlob = mb; sc.mediaType = s.mediaType === 'video' ? 'video' : 'image'; sc.mediaObjectURL = URL.createObjectURL(mb); }
      setAudio(sc, await get(s.audio));
      proj.scenes.push(sc);
    }
    dubPersonalProjects.push(proj);
    if (typeof dubSwitchProjTab === 'function' && !isAdmin) dubSwitchProjTab(1);
    dubOpenPersonalProject(proj.id);
    return { proj, source: 'personal', baseId: null };
  }

  tool = CloudTool.attach({
    kind: 'dub', label: '더빙',
    ids: { save: 'btnDubCloudSave', open: 'btnDubCloudOpen', status: 'dubCloudStatus' },
    defaultTitle: meta => (meta && meta.proj && meta.proj.title) || '나의 더빙',
    confirmOpenText: '저장된 더빙 작업을 불러올까요?\n(기본 작품이면 지금 그 작품에 한 녹음이 바뀌어요)',
    ensureMode: () => U.switchTo('dub'),
    ready: () => U.waitFor(() => typeof dubProjects !== 'undefined', 3000),
    currentMeta: () => {
      const m = currentProject();
      if (!m) { alert('먼저 작품을 고르거나 직접 만들어 주세요.'); return null; }
      return m;
    },
    matchesCurrent: meta => { const c = currentProject(); return !c || c.proj === meta.proj; },   // 작품 목록 화면이면 연결된 작품을 그대로 저장
    canContinue:(d, meta) => !!d && d.source === meta.source && (meta.source === 'personal' || String(d.baseId) === meta.baseId),
    isStale: meta => !meta.proj || (meta.source === 'personal' ? !dubPersonalProjects.includes(meta.proj) : !dubProjects.includes(meta.proj)),
    validate: d => !!d && d.v === 1 && (d.source === 'personal' || d.source === 'base') && Array.isArray(d.scenes),
    buildState, apply,
    onBind: meta => { lastSig = sigOf(meta); },
    watch: touch => {
      // 녹음·장면 편집 경로가 많아서 2초마다 작품 상태를 비교해 바뀌었을 때만 저장 예약
      setInterval(() => {
        const b = tool && tool.bound; if (!b) return;
        const s = sigOf(b.meta);
        if (s !== lastSig) { lastSig = s; touch(); }
        else if (!b.meta.proj || (b.meta.source === 'personal' && !dubPersonalProjects.includes(b.meta.proj))) touch();   // 작품 삭제 → 연결 해제
      }, 2000);
    },
  });
  window.DubCloud = tool;
})();
