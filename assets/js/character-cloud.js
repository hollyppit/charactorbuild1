// 캐릭터 꾸미기 ↔ 계정 저장 어댑터. cloud-tool.js 다음에 불러온다.
// 고른 아이템은 id 와 위치만 저장하고(그림 파일은 이미 사이트에 있음), "내 배경 이미지"만 파일로 올린다.
// index.html 전역(state, assets, positions, activeInstances, layerOrder, instanceCounter, applyAll 등)을 사용하며 도구 코드는 수정하지 않는다.
(function () {
  if (!window.CloudTool) return;
  const U = CloudTool.util;
  const $ = id => document.getElementById(id);
  const CATS = ['character', 'effect', 'prop'];
  let gen = 0;          // "초기화"할 때마다 1 증가 → 연결 해제 판단
  let lastSig = null;
  let tool = null;

  const num = (v, d, lo, hi) => { v = Number(v); if (!isFinite(v)) return d; return Math.min(hi, Math.max(lo, v)); };
  function cleanPos(p) {
    p = p || {};
    return { scale: num(p.scale, 100, 5, 500), offsetX: num(p.offsetX, 0, -2000, 2000), offsetY: num(p.offsetY, 0, -2000, 2000),
      rotate: num(p.rotate, 0, -360, 360), flip: !!p.flip, flipV: !!p.flipV };
  }
  const isHttp = s => typeof s === 'string' && /^https?:\/\//.test(s);
  const userBgItem = () => (assets.bg || []).find(i => i.id === 'user_bg');

  function snapshot() {
    const ub = state.bg === 'user_bg' ? userBgItem() : null;
    return {
      name: ($('nameInput') || {}).value || '',
      bg: state.bg || 'none',
      bgPos: positions.bg_image ? cleanPos(positions.bg_image) : null,
      items: activeInstances.map(i => ({ uid: i.uid, catId: i.catId, itemId: i.itemId, src: isHttp(i.src) ? i.src : '', pos: cleanPos(positions[i.uid]) })),
      order: layerOrder.slice(),
      _ub: ub && ub.src ? ub.src.length + ':' + ub.src.slice(-48) : '',
    };
  }
  const sig = () => { try { return JSON.stringify(snapshot()); } catch (e) { return ''; } };

  function captureThumb() {
    return new Promise(resolve => {
      let done = false;
      const fin = v => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => fin(null), 5000);
      try { captureDressupThumb(c => U.thumbFromCanvas(c).then(fin, () => fin(null))); } catch (e) { fin(null); }
    });
  }

  async function buildState(ctx) {
    const s = snapshot();
    delete s._ub;
    s.v = 1; s.userBg = null;
    if (s.bg === 'user_bg') {
      const ub = userBgItem();
      if (ub && typeof ub.src === 'string' && ub.src.startsWith('data:')) {
        const blob = await U.shrinkImage(ub.src, 1600);
        if (blob) s.userBg = await ctx.upload(blob, ub.src);
      }
      if (!s.userBg) s.bg = 'none';
    }
    let thumbAsset;
    const tb = await captureThumb();
    if (tb) thumbAsset = await ctx.upload(tb);
    return { data: s, thumbAsset };
  }

  function clearStage() {
    activeInstances.forEach(inst => { const el = $('lyr-' + inst.uid); if (el) el.remove(); });
    activeInstances.forEach(inst => { delete positions[inst.uid]; });
    activeInstances = [];
    layerOrder = ['bg_image'];
    try { deselectLayer(); } catch (e) {}
    try { clearPreviewLayer(); } catch (e) {}
  }

  async function apply(data, files) {
    clearStage();
    // 내 배경 이미지
    if (data.userBg) {
      try {
        const blob = await U.fetchAsset(files, data.userBg);
        if (blob) {
          const src = await U.blobToDataUrl(blob);
          if (!assets.bg) assets.bg = [];
          let it = userBgItem();
          if (it) it.src = src; else assets.bg.push({ id: 'user_bg', label: '내 배경', emoji: '🖼️', src, bgEmoji: '' });
        }
      } catch (e) { console.warn('내 배경 불러오기 실패:', e); }
    }
    state.bg = (assets.bg || []).some(i => i.id === data.bg) ? data.bg : 'none';

    let missing = 0, maxN = 0;
    const used = new Set();
    const stage = $('stage');
    for (const it of data.items) {
      if (!it || !CATS.includes(it.catId)) continue;
      const item = (assets[it.catId] || []).find(x => x.id === it.itemId);
      const src = (item && item.src) || (isHttp(it.src) ? it.src : '');
      if (!src) { missing++; continue; }
      let uid = typeof it.uid === 'string' && /^inst_\d{1,9}$/.test(it.uid) && !used.has(it.uid) ? it.uid : null;
      if (!uid) { do { uid = 'inst_' + (++maxN + 100000); } while (used.has(uid)); }
      used.add(uid);
      maxN = Math.max(maxN, Number(uid.slice(5)) || 0);
      positions[uid] = cleanPos(it.pos);
      activeInstances.push({ uid, catId: it.catId, itemId: it.itemId, src });
      const img = document.createElement('img');
      img.id = 'lyr-' + uid; img.className = 'char-layer'; img.alt = ''; img.draggable = false;
      stage.appendChild(img);
    }
    instanceCounter = Math.max(instanceCounter || 0, maxN);
    const known = new Set(activeInstances.map(i => i.uid));
    const order = ['bg_image'];
    (Array.isArray(data.order) ? data.order : []).forEach(u => { if (known.has(u) && !order.includes(u)) order.push(u); });
    activeInstances.forEach(i => { if (!order.includes(i.uid)) order.push(i.uid); });
    layerOrder = order;

    const name = String(data.name || '').slice(0, 12);
    const ni = $('nameInput'); if (ni) ni.value = name;
    const nt = $('nameTag'); if (nt) nt.textContent = name || '나의 캐릭터';

    CATEGORIES.forEach(c => buildOpts(c.id));
    applyAllZIndexes();
    applyAll();
    if (data.bgPos) {
      positions.bg_image = cleanPos(data.bgPos);
      const bgItem = (assets.bg || []).find(i => i.id === state.bg);
      applyLayer('bg_image', (bgItem && bgItem.src) || '', 'bg', 'bg_image');
    }
    if (missing) setTimeout(() => alert('지금은 없는 아이템 ' + missing + '개는 빼고 불러왔어요.'), 0);
    lastSig = sig();
    return { gen };
  }

  tool = CloudTool.attach({
    kind: 'character', label: '캐릭터',
    ids: { save: 'btnChCloudSave', open: 'btnChCloudOpen', status: 'chCloudStatus' },
    defaultTitle: () => (($('nameInput') || {}).value || '나의 캐릭터'),
    confirmOpenText: '지금 꾸미고 있는 캐릭터가 이 작업의 내용으로 바뀌어요.\n계속할까요?',
    ensureMode: () => U.switchTo('dressup'),
    ready: () => U.waitFor(() => !!document.querySelector('#opts-bg .opt-item'), 15000),   // 아이템 목록을 다 불러온 뒤
    currentMeta: () => ({ gen }),
    isStale: meta => meta.gen !== gen,
    validate: d => !!d && d.v === 1 && Array.isArray(d.items),
    buildState, apply,
    onBind: () => { lastSig = sig(); },
    watch: touch => {
      // 캐릭터 상태는 작아서 2초마다 비교해 바뀌었을 때만 저장 예약 (도구 함수를 고치지 않기 위해)
      setInterval(() => {
        if (!tool || !tool.bound) return;
        const s = sig();
        if (s !== lastSig) { lastSig = s; touch(); }
      }, 2000);
      // "초기화" = 새 캐릭터 시작 → 계정 작업과 연결 해제
      if (typeof window.resetAll === 'function') {
        const orig = window.resetAll;
        window.resetAll = function () { gen++; const r = orig.apply(this, arguments); touch(); return r; };
      }
    },
  });
  window.CharacterCloud = tool;
})();
