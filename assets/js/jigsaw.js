// 직소 퍼즐 엔진 (그림 퍼즐). window.Jigsaw
//  Jigsaw.LEVELS: 난이도(조각 수·도움)
//  Jigsaw.create(container, { image, level, seed, onProgress(placed, total), onComplete() }) → Promise<{ total, preview(), toggleEdges(), destroy(), placed() }>
// 조각 모양(볼록·오목)과 처음 흩어진 자리는 seed 로 정해져서, 같은 seed 면 친구와 똑같은 퍼즐이 된다.
// 조각을 끌어 제자리 가까이에 놓으면 딱 붙고 더는 움직이지 않는다. 조각 그림은 브라우저에서 바로 잘라 만든다(서버 저장 없음).
(function () {
  const LEVELS = {
    easy:   { name: '쉬움',        pieces: 12,  ghost: true,  previews: Infinity, edges: true },
    normal: { name: '보통',        pieces: 24,  ghost: true,  previews: 3,        edges: true },
    hard:   { name: '어려움',      pieces: 48,  ghost: false, previews: 1,        edges: true },
    expert: { name: '아주 어려움', pieces: 80,  ghost: false, previews: 0,        edges: true },
    master: { name: '🔥 도전',     pieces: 120, ghost: false, previews: 0,        edges: false },
  };

  // 같은 seed → 같은 난수
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => rej(new Error('그림을 불러오지 못했어요.')); i.src = src; });

  // 조각 한 변: (x0,y0)→(x1,y1), s = 볼록(1)·오목(-1)·평평(0), 바깥쪽 방향 (nx,ny), t = 혹 크기
  function side(ctx, x0, y0, x1, y1, s, nx, ny, t) {
    if (!s) { ctx.lineTo(x1, y1); return; }
    const dx = x1 - x0, dy = y1 - y0;
    const P = (u, v) => [x0 + dx * u + nx * v * t * s, y0 + dy * u + ny * v * t * s];
    const a = P(0.35, 0), b = P(0.65, 0);
    ctx.lineTo(...a);
    ctx.bezierCurveTo(...P(0.42, 0.25), ...P(0.25, 1.05), ...P(0.5, 1.05));
    ctx.bezierCurveTo(...P(0.75, 1.05), ...P(0.58, 0.25), ...b);
    ctx.lineTo(x1, y1);
  }
  function piecePath(ctx, x, y, w, h, e, t) {
    ctx.beginPath(); ctx.moveTo(x, y);
    side(ctx, x, y, x + w, y, e.top, 0, -1, t);
    side(ctx, x + w, y, x + w, y + h, e.right, 1, 0, t);
    side(ctx, x + w, y + h, x, y + h, e.bottom, 0, 1, t);
    side(ctx, x, y + h, x, y, e.left, -1, 0, t);
    ctx.closePath();
  }

  async function create(container, opts) {
    const L = LEVELS[opts.level] || LEVELS.easy;
    const img = await loadImg(opts.image);
    const R = rng(opts.seed || 1);
    const aspect = img.naturalWidth / img.naturalHeight;
    let cols = Math.max(2, Math.round(Math.sqrt(L.pieces * aspect)));
    let rows = Math.max(2, Math.round(L.pieces / cols));
    const total = cols * rows;

    container.innerHTML = '';
    const W = Math.min(container.clientWidth || 360, 900);
    const boardW = W * 0.86, boardH = boardW / aspect;
    const pw = boardW / cols, ph = boardH / rows, t = Math.min(pw, ph) * 0.22;
    const bx = (W - boardW) / 2, by = t + 6;
    const trayTop = by + boardH + t + 16, trayH = Math.max(boardH * 1.1, Math.ceil(total / Math.floor(W / (pw + t))) * (ph + t) * 0.7 + 40);
    const H = trayTop + trayH;
    const root = document.createElement('div');
    root.style.cssText = 'position:relative;width:' + W + 'px;height:' + H + 'px;margin:0 auto;touch-action:none;user-select:none;-webkit-user-select:none';
    const board = document.createElement('div');
    board.style.cssText = 'position:absolute;left:' + bx + 'px;top:' + by + 'px;width:' + boardW + 'px;height:' + boardH + 'px;border:3px dashed #ff4fa3;box-sizing:content-box;margin:-3px;background:rgba(255,255,255,.06)';
    if (L.ghost) { board.style.backgroundImage = 'url("' + opts.image + '")'; board.style.backgroundSize = '100% 100%'; board.style.backgroundBlendMode = 'luminosity'; board.style.opacity = '1'; const veil = document.createElement('div'); veil.style.cssText = 'position:absolute;inset:0;background:rgba(20,0,20,.78)'; board.append(veil); }
    const tray = document.createElement('div');
    tray.style.cssText = 'position:absolute;left:0;top:' + (trayTop - 8) + 'px;width:' + W + 'px;height:' + (trayH + 8) + 'px;border-top:2px solid #3a2a3a';
    root.append(board, tray);
    container.append(root);

    // 그림을 판 크기로 한 번 그려 두고 조각마다 잘라 쓴다
    const dpr = Math.min(2, window.devicePixelRatio || 1);   // 선명하게 (고해상도 화면)
    const full = document.createElement('canvas'); full.width = Math.round(boardW * dpr); full.height = Math.round(boardH * dpr);
    full.getContext('2d').drawImage(img, 0, 0, full.width, full.height);

    // 이웃끼리 맞물리는 볼록·오목
    const hEdge = [], vEdge = [];
    for (let r = 0; r < rows - 1; r++) { hEdge[r] = []; for (let c = 0; c < cols; c++) hEdge[r][c] = R() < 0.5 ? 1 : -1; }
    for (let r = 0; r < rows; r++) { vEdge[r] = []; for (let c = 0; c < cols - 1; c++) vEdge[r][c] = R() < 0.5 ? 1 : -1; }

    const pieces = [];
    let placed = 0, top = 10;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const e = { top: r ? -hEdge[r - 1][c] : 0, bottom: r < rows - 1 ? hEdge[r][c] : 0, left: c ? -vEdge[r][c - 1] : 0, right: c < cols - 1 ? vEdge[r][c] : 0 };
      const cw = pw + 2 * t, ch = ph + 2 * t;
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(cw * dpr); cv.height = Math.ceil(ch * dpr);
      cv.style.cssText = 'position:absolute;width:' + cw + 'px;height:' + ch + 'px;cursor:grab;filter:drop-shadow(1px 2px 2px rgba(0,0,0,.55))';
      const x = cv.getContext('2d'); x.scale(dpr, dpr);
      piecePath(x, t, t, pw, ph, e, t);
      x.save(); x.clip();
      x.drawImage(full, (c * pw - t) * dpr, (r * ph - t) * dpr, cw * dpr, ch * dpr, 0, 0, cw, ch);
      x.restore();
      x.lineWidth = 1; x.strokeStyle = 'rgba(0,0,0,.45)'; piecePath(x, t, t, pw, ph, e, t); x.stroke();
      const p = { el: cv, r, c, edge: !e.top || !e.bottom || !e.left || !e.right, done: false,
        hx: bx + c * pw - t, hy: by + r * ph - t,   // 제자리 (조각 그림 왼쪽 위)
        x: 4 + R() * Math.max(1, W - cw - 8), y: trayTop + R() * Math.max(1, trayH - ch - 4) };
      cv.style.left = p.x + 'px'; cv.style.top = p.y + 'px'; cv.style.zIndex = String(top++);
      root.append(cv); pieces.push(p);
    }

    // 끌기: 조각 그림의 투명한 부분을 누르면 아래 조각을 집는다
    const alphaAt = (p, cx, cy) => { try { const rect = p.el.getBoundingClientRect(); const sx = (cx - rect.left) / rect.width * p.el.width, sy = (cy - rect.top) / rect.height * p.el.height; return p.el.getContext('2d').getImageData(Math.floor(sx), Math.floor(sy), 1, 1).data[3]; } catch (e2) { return 255; } };
    let drag = null;
    root.addEventListener('pointerdown', ev => {
      const hits = document.elementsFromPoint(ev.clientX, ev.clientY).map(el => pieces.find(p => p.el === el)).filter(p => p && !p.done);
      const p = hits.find(q => alphaAt(q, ev.clientX, ev.clientY) > 20) || null;
      if (!p) return;
      ev.preventDefault();
      root.setPointerCapture(ev.pointerId);
      const rr = root.getBoundingClientRect();
      drag = { p, dx: ev.clientX - rr.left - p.x, dy: ev.clientY - rr.top - p.y, id: ev.pointerId };
      p.el.style.zIndex = String(top++); p.el.style.cursor = 'grabbing';
    });
    root.addEventListener('pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id) return;
      const rr = root.getBoundingClientRect(), p = drag.p;
      p.x = Math.max(-t, Math.min(W - pw - t, ev.clientX - rr.left - drag.dx));
      p.y = Math.max(0, Math.min(H - ph - t, ev.clientY - rr.top - drag.dy));
      p.el.style.left = p.x + 'px'; p.el.style.top = p.y + 'px';
    });
    const drop = ev => {
      if (!drag || (ev && ev.pointerId !== drag.id)) return;
      const p = drag.p; drag = null; p.el.style.cursor = 'grab';
      const snap = Math.min(pw, ph) * 0.3;
      if (Math.abs(p.x - p.hx) < snap && Math.abs(p.y - p.hy) < snap) {
        p.x = p.hx; p.y = p.hy; p.el.style.left = p.x + 'px'; p.el.style.top = p.y + 'px';
        p.done = true; p.el.style.zIndex = '1'; p.el.style.cursor = 'default'; p.el.style.filter = 'none';
        p.el.animate && p.el.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 180 });
        placed++;
        opts.onProgress && opts.onProgress(placed, total);
        if (placed === total) { board.style.borderColor = '#3c3'; opts.onComplete && opts.onComplete(); }
      }
    };
    root.addEventListener('pointerup', drop); root.addEventListener('pointercancel', drop);

    let previews = L.previews, edgesOnly = false;
    return {
      total, cols, rows, level: L, mode: 'jigsaw',
      placed: () => placed,
      previewsLeft: () => previews,
      // 원래 그림 3초 보기 (단계마다 횟수 제한)
      preview() {
        if (previews <= 0) return false;
        previews--;
        const ov = document.createElement('div');
        ov.style.cssText = 'position:absolute;left:' + bx + 'px;top:' + by + 'px;width:' + boardW + 'px;height:' + boardH + 'px;z-index:99999;background:url("' + opts.image + '") center/100% 100%;border:3px solid #ffd400;box-sizing:border-box;pointer-events:none';
        root.append(ov); setTimeout(() => ov.remove(), 3000);
        return true;
      },
      // 가장자리 조각만 보기 (안쪽 조각을 잠시 숨김)
      toggleEdges() {
        if (!L.edges) return null;
        edgesOnly = !edgesOnly;
        pieces.forEach(p => { if (!p.done && !p.edge) p.el.style.visibility = edgesOnly ? 'hidden' : ''; });
        return edgesOnly;
      },
      destroy() { container.innerHTML = ''; },
    };
  }

  // ── 사각 조각 바꾸기 (휴대폰용): 판 위 네모 조각 두 개를 차례로 누르면 자리가 바뀜. 모두 제자리면 완성 ──
  async function createTiles(container, opts) {
    const L = LEVELS[opts.level] || LEVELS.easy;
    const img = await loadImg(opts.image);
    const R = rng(opts.seed || 1);
    const aspect = img.naturalWidth / img.naturalHeight;
    const cols = Math.max(2, Math.round(Math.sqrt(L.pieces * aspect)));
    const rows = Math.max(2, Math.round(L.pieces / cols));
    const total = cols * rows;
    container.innerHTML = '';
    const W = Math.min(container.clientWidth || 360, 900), H = W / aspect;
    const tw = W / cols, th = H / rows;
    const root = document.createElement('div');
    root.style.cssText = 'position:relative;width:' + W + 'px;height:' + H + 'px;margin:0 auto;user-select:none;-webkit-user-select:none;border:3px solid #ff4fa3;box-sizing:content-box';
    container.append(root);
    // 섞기: 같은 seed 면 같은 섞임, 처음부터 다 맞으면 다시
    const order = [...Array(total).keys()];
    do { for (let i = total - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } } while (order.every((v, i) => v === i));
    const cells = [];   // cells[자리] = 조각 번호
    const tiles = [];
    for (let k = 0; k < total; k++) {
      const d = document.createElement('div');
      const pr = Math.floor(k / cols), pc = k % cols;
      d.style.cssText = 'position:absolute;width:' + tw + 'px;height:' + th + 'px;background-image:url("' + opts.image + '");background-size:' + W + 'px ' + H + 'px;background-position:' + (-pc * tw) + 'px ' + (-pr * th) + 'px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.35);cursor:pointer;transition:left .15s,top .15s';
      tiles.push(d); root.append(d);
    }
    let placed = 0, sel = null;
    const place = (cell, piece) => { cells[cell] = piece; const t2 = tiles[piece]; t2.style.left = (cell % cols) * tw + 'px'; t2.style.top = Math.floor(cell / cols) * th + 'px'; t2.dataset.cell = cell; };
    const recount = () => {
      let n = 0;
      cells.forEach((p, i) => { const ok = p === i; if (ok) n++; tiles[p].style.boxShadow = ok && L.ghost ? 'inset 0 0 0 2px #3c3' : 'inset 0 0 0 1px rgba(0,0,0,.35)'; });
      return n;
    };
    order.forEach((piece, cell) => place(cell, piece));
    placed = recount();
    root.addEventListener('click', ev => {
      const t2 = ev.target.closest('div[data-cell]'); if (!t2 || placed === total) return;
      const cell = +t2.dataset.cell;
      if (sel == null) { sel = cell; t2.style.outline = '3px solid #ffd400'; t2.style.zIndex = '2'; return; }
      const prev = tiles[cells[sel]]; prev.style.outline = ''; prev.style.zIndex = '';
      if (sel !== cell) { const a = cells[sel], b = cells[cell]; place(sel, b); place(cell, a); }
      sel = null;
      const before = placed; placed = recount();
      if (placed !== before) opts.onProgress && opts.onProgress(placed, total);
      if (placed === total) { root.style.borderColor = '#3c3'; opts.onComplete && opts.onComplete(); }
    });
    opts.onProgress && opts.onProgress(placed, total);
    let previews = L.previews;
    return {
      total, cols, rows, level: L, mode: 'tiles',
      placed: () => placed,
      previewsLeft: () => previews,
      preview() {
        if (previews <= 0) return false;
        previews--;
        const ov = document.createElement('div');
        ov.style.cssText = 'position:absolute;inset:0;z-index:99;background:url("' + opts.image + '") center/100% 100%;outline:3px solid #ffd400;pointer-events:none';
        root.append(ov); setTimeout(() => ov.remove(), 3000);
        return true;
      },
      toggleEdges: () => null,
      destroy() { container.innerHTML = ''; },
    };
  }

  // 휴대폰·태블릿(손가락 터치 또는 좁은 화면)이면 사각 조각이 기본
  const prefersTiles = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches) || (window.innerWidth || 1000) < 700;
  // mode: 'jigsaw' | 'tiles'
  const start = (container, opts) => (opts.mode === 'tiles' ? createTiles : create)(container, opts);

  window.Jigsaw = { LEVELS, create, createTiles, start, prefersTiles };
})();
