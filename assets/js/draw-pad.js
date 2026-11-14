// 그림 게임 공통 그림판 (5단계). window.DrawPad.create(parent, opts?) → { el, toImage(), clear(), isEmpty(), destroy() }
// opts.band = [k, K]: 그림을 위에서 아래로 K칸으로 나눈 것 중 k번째 칸만 밝게 보여 줌 (기억 조각 그림의 부위 칸). 안내용이라 낸 그림에는 안 들어감
// 펜 굵기 3가지, 색 8개, 지우개, 되돌리기, 전체 지우기. 그림은 480×360 으로 그리고 작게 압축해 낸다(서버 한도 200KB).
// 쓱싹 퀴즈: pad.takeNew() 가 마지막으로 가져간 뒤 새로 그은 획 조각 [{i,c,s,p:[[x,y]...]} | {op:'undo'|'clear'}] 을 돌려준다.
// DrawPad.viewer(parent) → { apply(items), reset(), toImage() }: 받은 획 조각을 차례로(움직이듯) 다시 그린다.
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
    const strokes = [];     // [{i, color, size, pts:[[x,y]...]}]  — 되돌리기용
    let cur = null, color = COLORS[0], size = SIZES[1][0], erasing = false;
    let seq = 0, pending = [], chunk = null;   // 획 조각 보내기용

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
      cur = { i: ++seq, color: erasing ? '#ffffff' : color, size: erasing ? Math.max(size, 14) * 1.6 : size, pts: [pos(e)] };
      strokes.push(cur); drawStroke(cur);
      chunk = { i: cur.i, c: cur.color, s: cur.size, p: [cur.pts[0]] }; pending.push(chunk);
    });
    cv.addEventListener('pointermove', e => {
      if (!cur) return;
      const p = pos(e), last = cur.pts[cur.pts.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 2) return;
      cur.pts.push(p);
      if (chunk) chunk.p.push(p);
      ctx.strokeStyle = cur.color; ctx.lineWidth = cur.size; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
    });
    const end = () => { cur = null; chunk = null; };
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
    const undo = tool('↶ 되돌리기', () => { if (!strokes.length) return; strokes.pop(); redraw(); pending.push({ op: 'undo' }); });
    const clr = tool('🗑 전체 지우기', () => { if (strokes.length && !confirm('그림을 모두 지울까요?')) return; strokes.length = 0; redraw(); pending.push({ op: 'clear' }); });
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
    // 새 획 조각 가져가기 (긋는 중인 획은 다음 조각이 마지막 점부터 이어짐)
    function takeNew() {
      const out = pending.filter(x => x.op || x.p.length);
      pending = [];
      if (cur) { chunk = { i: cur.i, c: cur.color, s: cur.size, p: [cur.pts[cur.pts.length - 1]] }; pending.push(chunk); }
      return out;
    }
    return { el: wrap, toImage, takeNew, clear: () => { strokes.length = 0; redraw(); }, isEmpty: () => !strokes.length, destroy: () => wrap.remove() };
  }

  // 받은 획 조각 다시 그리기 (그리는 모습처럼 조금씩). 화면이 숨어 있어도 돌도록 setTimeout 사용
  function viewer(parent, opts) {
    opts = opts || {};
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    cv.style.cssText = 'width:100%;max-width:' + (opts.max || 560) + 'px;aspect-ratio:4/3;background:#fff;border:3px solid #000;display:block;margin:0 auto;box-sizing:border-box';
    parent.append(cv);
    const ctx = cv.getContext('2d');
    const strokes = [];   // [{i, c, s, pts}]
    const queue = [];     // 그릴 차례를 기다리는 [stroke, point index]
    let timer = null;
    const bg = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); };
    const seg = (st, a, b) => { ctx.strokeStyle = st.c; ctx.lineWidth = st.s; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0] + (a === b ? 0.01 : 0), b[1]); ctx.stroke(); };
    const full = () => { bg(); strokes.forEach(st => { for (let k = 0; k < st.drawn; k++) seg(st, st.pts[Math.max(0, k - 1)], st.pts[k]); }); };
    bg();
    function pump() {
      timer = null;
      let budget = opts.instant ? 1e9 : Math.max(6, Math.ceil(queue.length / 12));   // 밀려 있으면 빨리
      while (budget-- > 0 && queue.length) {
        const st = queue[0];
        if (st.drawn >= st.pts.length) { queue.shift(); continue; }
        const k = st.drawn; seg(st, st.pts[Math.max(0, k - 1)], st.pts[k]); st.drawn++;
      }
      if (queue.length) timer = setTimeout(pump, 30);
    }
    function apply(items) {
      for (const it of items || []) {
        if (it.op === 'clear') { strokes.length = 0; queue.length = 0; bg(); continue; }
        if (it.op === 'undo') { const last = strokes.pop(); if (last) { const qi = queue.indexOf(last); if (qi >= 0) queue.splice(qi, 1); } full(); continue; }
        let st = strokes[strokes.length - 1];
        if (!st || st.i !== it.i) { st = { i: it.i, c: it.c, s: it.s, pts: [], drawn: 0 }; strokes.push(st); }
        const add = st.pts.length && it.p.length && st.pts[st.pts.length - 1][0] === it.p[0][0] && st.pts[st.pts.length - 1][1] === it.p[0][1] ? it.p.slice(1) : it.p;
        st.pts.push(...add);
        if (!queue.includes(st)) queue.push(st);
      }
      if (!timer) pump();
    }
    return { el: cv, apply, reset: () => { strokes.length = 0; queue.length = 0; bg(); }, toImage: () => cv.toDataURL('image/png') };
  }

  window.DrawPad = { create, viewer };
})();
