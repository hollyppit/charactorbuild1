// 그림 게임 공통 그림판 (5단계). window.DrawPad.create(parent, opts?) → { el, toImage(), clear(), isEmpty(), destroy() }
// opts.band = [k, K]: 그림을 위에서 아래로 K칸으로 나눈 것 중 k번째 칸만 밝게 보여 줌 (기억 조각 그림의 부위 칸). 안내용이라 낸 그림에는 안 들어감
// 펜 굵기 3가지, 색 8개, 지우개, 되돌리기, 전체 지우기. 그림은 480×360 으로 그리고 작게 압축해 낸다(서버 한도 200KB).
(function () {
  const W = 480, H = 360;
  const COLORS = ['#111111', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#8d6e63'];
  const SIZES = [[3, '가늘게'], [7, '보통'], [14, '굵게']];

  function create(parent, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    cv.style.cssText = 'width:100%;aspect-ratio:4/3;background:#fff;border:3px solid #000;touch-action:none;display:block;cursor:crosshair;box-sizing:border-box';
    const holder = document.createElement('div');
    holder.style.cssText = 'position:relative;width:100%;max-width:560px;margin:0 auto';
    holder.append(cv);
    if (Array.isArray(opts.band)) {
      const [k, K] = opts.band;
      const shade = (top, h) => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;left:3px;right:3px;pointer-events:none;background:rgba(40,40,60,.38);top:' + top + '%;height:' + h + '%'; holder.append(d); };
      const t = 100 * k / K, b = 100 * (k + 1) / K;
      if (t > 0) shade(0, t);
      if (b < 100) shade(b, 100 - b);
      const line = document.createElement('div'); line.style.cssText = 'position:absolute;left:3px;right:3px;pointer-events:none;border:3px dashed #ff4fa3;box-sizing:border-box;top:' + t + '%;height:' + (b - t) + '%'; holder.append(line);
    }
    const ctx = cv.getContext('2d');
    const strokes = [];     // [{color, size, pts:[[x,y]...]}]  — 되돌리기용
    let cur = null, color = COLORS[0], size = SIZES[1][0], erasing = false;

    function paintBg() { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
    function drawStroke(s) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.01, s.pts[0][1]);
      ctx.stroke();
    }
    function redraw() { paintBg(); strokes.forEach(drawStroke); }
    paintBg();

    const pos = e => { const r = cv.getBoundingClientRect(); return [Math.round((e.clientX - r.left) * W / r.width), Math.round((e.clientY - r.top) * H / r.height)]; };
    cv.addEventListener('pointerdown', e => {
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      cur = { color: erasing ? '#ffffff' : color, size: erasing ? Math.max(size, 14) * 1.6 : size, pts: [pos(e)] };
      strokes.push(cur); drawStroke(cur);
    });
    cv.addEventListener('pointermove', e => {
      if (!cur) return;
      const p = pos(e), last = cur.pts[cur.pts.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 2) return;
      cur.pts.push(p);
      ctx.strokeStyle = cur.color; ctx.lineWidth = cur.size; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    });
    const end = () => { cur = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end); cv.addEventListener('pointerleave', end);

    // 도구 막대
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;align-items:center';
    const sw = [];
    const select = b => { [...bar.querySelectorAll('[data-k]')].forEach(x => { x.style.outline = x === b ? '3px solid var(--yellow,#ffd400)' : 'none'; }); };
    COLORS.forEach(c => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.k = 'c'; b.title = '색';
      b.style.cssText = 'width:30px;height:30px;border:2px solid #000;border-radius:50%;cursor:pointer;background:' + c;
      b.onclick = () => { color = c; erasing = false; select(b); };
      bar.append(b); sw.push(b);
    });
    const sizeBox = document.createElement('div'); sizeBox.style.cssText = 'display:flex;gap:4px';
    const sizeBtns = SIZES.map(([v, t]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = t;
      b.onclick = () => { size = v; sizeBtns.forEach(x => x.classList.toggle('on', x === b)); };
      sizeBox.append(b); return b;
    });
    sizeBtns[1].classList.add('on');
    const tool = (t, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = t; b.onclick = fn; return b; };
    const er = tool('🧽 지우개', () => { erasing = true; select(er); }); er.dataset.k = 'e';
    const undo = tool('↶ 되돌리기', () => { strokes.pop(); redraw(); });
    const clr = tool('🗑 전체 지우기', () => { if (strokes.length && !confirm('그림을 모두 지울까요?')) return; strokes.length = 0; redraw(); });
    bar.append(sizeBox, er, undo, clr);
    select(sw[0]);

    wrap.append(holder, bar);
    parent.append(wrap);

    // 낼 그림: webp → 안 되면 jpeg, 200KB 넘으면 품질을 낮춤
    function toImage() {
      for (const q of [0.8, 0.6, 0.45]) {
        let d = cv.toDataURL('image/webp', q);
        if (!d.startsWith('data:image/webp')) d = cv.toDataURL('image/jpeg', q);
        if (d.length <= 190000) return d;
      }
      return cv.toDataURL('image/jpeg', 0.3);
    }
    return { el: wrap, toImage, clear: () => { strokes.length = 0; redraw(); }, isEmpty: () => !strokes.length, destroy: () => wrap.remove() };
  }

  window.DrawPad = { create };
})();
