// 작품 게시하기 (3단계-A). auth-client.js 다음에 불러온다.
// 각 도구의 지금 화면을 그림(JPEG, 긴 변 1600px)으로 만들어 게시물로 올린다. 원본 작업 파일은 계속 비공개.
// 공개 스위치(/api/config 의 social)가 'on' 이거나, 'beta' 이면서 관리자 역할 회원일 때만 버튼이 보인다.
(function () {
  if (!window.BoldAuth) return;
  const $ = id => document.getElementById(id);
  const MAX_SIDE = 1600;
  const TOOLS = {
    draw: { btn: 'btnDrawPublish', label: '직접 그리기' },
    character: { btn: 'btnChPublish', label: '캐릭터' },
    storyboard: { btn: 'btnSbPublish', label: '스토리보드' },
    story: { btn: 'btnStPublish', label: '스토리' },
    dub: { btn: 'btnDubPublish', label: '그림책 더빙' },
  };
  const MAX_FILE = 10 * 1024 * 1024;
  const VIDEO_OK = ['video/mp4', 'video/webm', 'video/quicktime'];
  const AUDIO_OK = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
  const baseType = t => String(t || '').split(';')[0].trim().toLowerCase();

  // 동영상 → {width, height, poster(캔버스)}. 첫 장면 그림을 포스터로 쓴다
  function videoInfo(src) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      const t = setTimeout(() => reject(new Error('동영상을 읽지 못했어요.')), 15000);
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.2, (v.duration || 1) / 2); } catch (e) {} };
      v.onseeked = () => {
        clearTimeout(t);
        const c = document.createElement('canvas'); c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
        try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); } catch (e) {}
        resolve({ width: c.width, height: c.height, poster: c });
      };
      v.onerror = () => { clearTimeout(t); reject(new Error('동영상을 읽지 못했어요.')); };
      v.src = src;
    });
  }
  // 그림이 없는 장면용 글자 카드
  function textCard(text) {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const x = c.getContext('2d'); x.fillStyle = '#1a1a2e'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.font = 'bold 48px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(text || '').slice(0, 30), c.width / 2, c.height / 2);
    return c;
  }

  function hasSessionHint() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && /^sb-.+-auth-token$/.test(k)) return true; } } catch (e) {}
    return false;
  }
  // 기본 작품 그림처럼 다른 주소(http)의 그림은 crossOrigin 으로 불러와야 게시용으로 다시 그릴 수 있다
  const loadImg = src => new Promise((res, rej) => { const i = new Image(); if (/^https?:/.test(src)) i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => rej(new Error('그림을 읽지 못했어요.')); i.src = src; });
  async function sha256hex(blob) {
    const h = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 캔버스·이미지 → 게시용 JPEG {blob, width, height}
  async function toJpeg(src) {
    const el = typeof src === 'string' ? await loadImg(src) : src;
    const w0 = el.naturalWidth || el.width, h0 = el.naturalHeight || el.height;
    if (!w0 || !h0) throw new Error('빈 그림이에요.');
    const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(el, 0, 0, c.width, c.height);
    let blob = null;
    for (const q of [0.88, 0.75, 0.6]) {
      blob = await new Promise(r => { try { c.toBlob(r, 'image/jpeg', q); } catch (e) { r(null); } });
      if (!blob) throw new Error('이 그림은 게시용으로 만들 수 없어요. (사이트 밖에서 가져온 그림이 섞여 있을 수 있어요)');
      if (blob.size <= 9.5 * 1024 * 1024) break;
    }
    return { blob, width: c.width, height: c.height };
  }

  // 도구별로 지금 화면의 그림 목록과 기본 제목 만들기: { title, items:[{src, body}], projectId }
  async function collect(tool) {
    if (tool === 'draw') {
      if (typeof flattenDrawCanvas !== 'function') throw new Error('그림판이 준비되지 않았어요.');
      const b = window.DrawCloud && DrawCloud.bound;
      return { title: (b && b.title) || '나의 그림', items: [{ src: flattenDrawCanvas(), body: '' }], projectId: b && b.id };
    }
    if (tool === 'character') {
      const canvas = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('캐릭터 그림을 만들지 못했어요.')), 8000);
        try { captureDressupThumb(c => { clearTimeout(t); res(c); }); } catch (e) { clearTimeout(t); rej(e); }
      });
      const b = window.CharacterCloud && CharacterCloud.bound;
      return { title: ($('nameInput') || {}).value || (b && b.title) || '나의 캐릭터', items: [{ src: canvas, body: '' }], projectId: b && b.id };
    }
    if (tool === 'storyboard') {
      const items = [];
      const result = window.StoryboardCloud && StoryboardCloud.getLastResult && StoryboardCloud.getLastResult();
      const desc = ($('sbSceneDesc') || {}).value || '';
      if (result) items.push({ src: result, body: desc });
      items.push({ src: $('sbCanvas'), body: result ? '스케치' : desc });
      const b = window.StoryboardCloud && StoryboardCloud.bound;
      return { title: (b && b.title) || '나의 스토리보드', items, projectId: b && b.id };
    }
    if (tool === 'story') {
      if (typeof stS === 'undefined') throw new Error('스토리가 아직 준비되지 않았어요.');
      if (!stS.loaded) await (stS.loading || (stS.loading = stLoad()));
      const p = stS.proj[stS.cur];
      const items = [];
      if (p.cover && p.cover.image) items.push({ src: p.cover.image, body: p.logline || '' });
      for (const sc of p.scenes || []) if (sc.image) items.push({ src: sc.image, body: sc.script || '' });
      if (!items.length) throw new Error('게시할 장면 그림이 없어요. 장면 그림을 먼저 만들어 주세요.');
      const b = window.StoryCloud && StoryCloud.bound;
      return { title: p.title || (b && b.title) || '나의 그림책', items: items.slice(0, 20), projectId: b && b.id, more: items.length > 20 };
    }
    if (tool === 'dub') {
      if (typeof dubCurrentProjectId === 'undefined' || dubCurrentProjectId == null) throw new Error('먼저 더빙할 작품을 고르거나 직접 만들어 주세요.');
      const proj = dubPersonalProjects.find(p => p.id === dubCurrentProjectId) || dubProjects.find(p => p.id === dubCurrentProjectId);
      if (!proj || !proj.scenes.length) throw new Error('장면이 없어요.');
      if (!proj.scenes.some(s => s.audioBlob)) throw new Error('녹음한 장면이 하나 이상 있어야 더빙을 게시할 수 있어요. "🎤 더빙하기"에서 먼저 녹음해 주세요.');
      const items = [], notes = [];
      for (const sc of proj.scenes.slice(0, 20)) {
        const it = { body: String(sc.text || sc.name || '').slice(0, 1000), audio: null };
        // 녹음
        if (sc.audioBlob) {
          const t = baseType(sc.audioBlob.type) || 'audio/webm';
          if (AUDIO_OK.includes(t) && sc.audioBlob.size <= MAX_FILE) it.audio = new Blob([sc.audioBlob], { type: t });
          else notes.push('"' + (sc.name || '장면') + '" 녹음은 형식이나 크기 때문에 빠져요.');
        }
        // 그림·동영상
        if (sc.mediaType === 'video' && sc.mediaObjectURL) {
          let blob = sc.mediaBlob;
          if (!blob) { try { blob = await (await fetch(sc.mediaObjectURL)).blob(); } catch (e) { blob = null; } }
          const info = await videoInfo(sc.mediaObjectURL);
          const t = blob && baseType(blob.type);
          if (blob && VIDEO_OK.includes(t) && blob.size <= MAX_FILE) { it.video = { blob: new Blob([blob], { type: t }), mime: t, width: info.width, height: info.height }; it.src = info.poster; }
          else { it.src = info.poster; notes.push('"' + (sc.name || '장면') + '" 동영상은 10MB가 넘거나 형식이 맞지 않아 첫 장면 사진으로 올라가요.'); }
        } else if (sc.mediaObjectURL) {
          it.src = sc.mediaObjectURL;
        } else {
          it.src = textCard(sc.name || sc.text || '');
        }
        items.push(it);
      }
      if (proj.scenes.length > 20) notes.push('장면은 20개까지만 게시돼요. 앞의 20개를 올려요.');
      const b = window.DubCloud && DubCloud.bound;
      return { title: proj.title || '나의 더빙', items, projectId: b && b.id, notes };
    }
    throw new Error('알 수 없는 도구');
  }

  function el(tag, css, text) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }

  async function openDialog(tool) {
    let data;
    try { data = await collect(tool); } catch (e) { alert(e.message); return; }
    const old = $('publishModal'); if (old) old.remove();
    const ov = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px');
    ov.id = 'publishModal';
    const box = el('div', 'background:#fff;color:#222;border:3px solid #222;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:18px;border-radius:10px;font-size:14px');
    box.appendChild(el('div', 'font-weight:800;font-size:1.15rem;margin-bottom:10px', '📤 ' + TOOLS[tool].label + ' 게시하기'));

    const strip = el('div', 'display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:10px');
    data.items.forEach(it => {
      const im = el('img', 'height:84px;border:1px solid #ccc;flex:none;background:#f5f5f5');
      im.alt = '';
      im.src = typeof it.src === 'string' ? it.src : (() => { try { return it.src.toDataURL('image/jpeg', 0.6); } catch (e) { return ''; } })();
      const cell = el('div', 'position:relative;flex:none');
      cell.appendChild(im);
      if (tool === 'dub') cell.appendChild(el('div', 'position:absolute;left:2px;bottom:2px;background:rgba(0,0,0,.65);color:#fff;font-size:11px;padding:1px 4px', (it.video ? '🎬 ' : '') + (it.audio ? '🎤' : '무음')));
      strip.appendChild(cell);
    });
    box.appendChild(strip);
    if (data.more) box.appendChild(el('div', 'color:#a33;font-size:12px;margin-bottom:8px', '그림은 20장까지만 게시돼요. 앞의 20장을 올려요.'));
    (data.notes || []).forEach(n => box.appendChild(el('div', 'color:#a33;font-size:12px;margin-bottom:4px', '※ ' + n)));
    if (tool === 'dub') box.appendChild(el('div', 'color:#555;font-size:12px;margin-bottom:6px', '🎤 목소리 녹음도 함께 올라가요. 녹음에서 이름·학교·연락처 같은 개인정보를 말하지 않았는지 확인해 주세요.'));

    const lab = t => el('div', 'font-weight:700;margin:10px 0 4px', t);
    const title = el('input', 'width:100%;padding:10px;border:2px solid #444;font-size:16px'); title.maxLength = 60; title.value = String(data.title || '').slice(0, 60);
    const cap = el('textarea', 'width:100%;min-height:80px;padding:10px;border:2px solid #444;font-size:15px'); cap.maxLength = 500; cap.placeholder = '작품 소개 (선택, 500자까지)';
    box.append(lab('제목'), title, lab('소개'), cap);
    const pick = (opts) => { const s = el('select', 'width:100%;padding:10px;border:2px solid #444;font-size:15px'); opts.forEach(([v, t]) => { const o = el('option', '', t); o.value = v; s.append(o); }); return s; };
    const vis = pick([['public', '전체 공개 — 누구나 볼 수 있어요'], ['followers', '팔로워만 — 내가 수락한 팔로워만 볼 수 있어요']]);
    const cmode = pick([['all', '누구나 (로그인한 회원)'], ['followers', '팔로워만'], ['off', '댓글 받지 않기']]);
    box.append(lab('공개 범위'), vis, lab('댓글'), cmode);

    let replaceBox = null, existing = null;
    if (data.projectId) {
      try {
        const r = await BoldAuth.api('/api/posts?mine=1&project=' + encodeURIComponent(data.projectId));
        existing = (r.posts || [])[0] || null;
      } catch (e) {}
      if (existing) {
        const row = el('label', 'display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:13px');
        replaceBox = el('input'); replaceBox.type = 'checkbox'; replaceBox.checked = true; replaceBox.style.marginTop = '3px';
        row.append(replaceBox, el('span', '', '이 작업으로 이미 올린 게시물 "' + existing.title + '"을(를) 지금 그림으로 바꾸기 (체크를 끄면 새 게시물로 올려요)'));
        box.appendChild(row);
      }
    }

    const agreeRow = el('label', 'display:flex;gap:8px;align-items:flex-start;margin-top:12px;font-size:13px;line-height:1.5');
    const agree = el('input'); agree.type = 'checkbox'; agree.style.marginTop = '3px';
    agreeRow.append(agree, el('span', '', '다른 사람의 얼굴·이름·연락처 같은 개인정보가 없고, 다른 사람의 작품을 허락 없이 쓰지 않았어요. 고른 공개 범위의 사람들이 볼 수 있어요.'));
    box.appendChild(agreeRow);
    box.appendChild(el('div', 'color:#666;font-size:12px;margin-top:8px', '운영 방식에 따라 관리자가 확인한 뒤 공개될 수 있어요. 게시 뒤 작업을 고쳐도 게시물은 바뀌지 않아요(다시 게시하면 바뀌어요).'));

    const msg = el('div', 'min-height:1.4em;margin-top:10px;font-weight:700');
    const btns = el('div', 'display:flex;gap:8px;margin-top:10px');
    const go = el('button', 'flex:1;padding:12px;font-weight:800;background:#222;color:#fff;border:0;cursor:pointer', '게시하기');
    const cancel = el('button', 'padding:12px 16px;font-weight:700;background:#eee;border:0;cursor:pointer', '닫기');
    btns.append(go, cancel); box.append(msg, btns);
    ov.appendChild(box); document.body.appendChild(ov);
    cancel.onclick = () => ov.remove();
    title.focus();

    go.onclick = async () => {
      if (!title.value.trim()) { msg.style.color = '#c00'; msg.textContent = '제목을 적어 주세요.'; return; }
      if (!agree.checked) { msg.style.color = '#c00'; msg.textContent = '확인 칸에 체크해 주세요.'; return; }
      go.disabled = true; cancel.disabled = true; msg.style.color = '#333';
      try {
        msg.textContent = '그림 준비 중...';
        const files = [];
        for (const it of data.items) {
          const j = it.video ? { blob: it.video.blob, width: it.video.width, height: it.video.height, mime: it.video.mime } : { ...(await toJpeg(it.src)), mime: 'image/jpeg' };
          const f = { ...j, sha256: await sha256hex(j.blob), body: String(it.body || '').slice(0, 1000) };
          if (it.audio) f.audio = { blob: it.audio, mime: it.audio.type, sha256: await sha256hex(it.audio) };
          files.push(f);
        }
        msg.textContent = '게시물 만드는 중...';
        const start = await BoldAuth.api('/api/posts', { method: 'POST', body: JSON.stringify({
          kind: tool, title: title.value.trim(), caption: cap.value.trim(), visibility: vis.value, comments_mode: cmode.value,
          source_project_id: data.projectId || undefined,
          replaces_post_id: replaceBox && replaceBox.checked && existing ? existing.id : undefined,
          media: files.map(f => ({ mime: f.mime, bytes: f.blob.size, width: f.width, height: f.height, sha256: f.sha256, body: f.body,
            audio: f.audio ? { mime: f.audio.mime, bytes: f.audio.blob.size, sha256: f.audio.sha256 } : undefined })),
        }) });
        const c = await BoldAuth.client();
        for (let i = 0; i < start.uploads.length; i++) {
          msg.textContent = '파일 올리는 중... ' + (i + 1) + '/' + start.uploads.length;
          const u = start.uploads[i];
          const f = files[u.idx];
          const part = u.part === 'audio' ? f.audio : f;
          const up = await c.storage.from(start.bucket).uploadToSignedUrl(u.path, u.token, part.blob, { contentType: part.mime });
          if (up.error) throw new Error('파일을 올리지 못했어요. 다시 해 주세요.');
        }
        msg.textContent = '마무리 중...';
        const fin = await BoldAuth.api('/api/posts?action=finish', { method: 'POST', body: JSON.stringify({ id: start.id }) });
        msg.style.color = '#1a8f4d';
        msg.textContent = fin.status === 'published' ? '게시됐어요! ✓' : '올렸어요! ' + (fin.status_text || '');
        btns.innerHTML = '';
        const view = el('a', 'flex:1;padding:12px;font-weight:800;background:#222;color:#fff;text-align:center;text-decoration:none', '게시물 보기');
        view.href = '/post?id=' + encodeURIComponent(start.id); view.target = '_blank'; view.rel = 'noopener';
        const close2 = el('button', 'padding:12px 16px;font-weight:700;background:#eee;border:0;cursor:pointer', '닫기');
        close2.onclick = () => ov.remove();
        btns.append(view, close2);
      } catch (e) {
        msg.style.color = '#c00';
        msg.textContent = e.message === 'login_required' ? '로그인이 필요해요.' : (e.message || '게시하지 못했어요.');
        go.disabled = false; cancel.disabled = false;
      }
    };
  }

  async function init() {
    let cfg = null;
    try { cfg = await (await fetch('/api/config')).json(); } catch (e) { return; }
    const mode = cfg && cfg.social;
    if (mode !== 'on' && mode !== 'beta') return;
    let member = false, beta = false;
    if (hasSessionHint()) {
      try { member = !!(await BoldAuth.session()); } catch (e) {}
      if (member && mode === 'beta') { try { beta = (await BoldAuth.api('/api/me')).role === 'admin'; } catch (e) {} }
    }
    const canSee = mode === 'on' || beta;
    const link = $('feedLink'); if (link && canSee) link.style.display = 'flex';
    if (!member || !canSee) return;
    // 🔔 알림 (읽지 않은 개수)
    if (link && !$('bellLink')) {
      const b = document.createElement('a');
      b.id = 'bellLink'; b.className = link.className; b.href = '/notifications'; b.title = '알림'; b.textContent = '🔔';
      b.style.cssText = 'display:flex;align-items:center;text-decoration:none';
      link.after(b);
      BoldAuth.api('/api/notifications?count=1').then(d => { if (d.unread) b.textContent = '🔔 ' + (d.unread >= 100 ? '99+' : d.unread); }).catch(() => {});
    }
    for (const [tool, t] of Object.entries(TOOLS)) {
      const b = $(t.btn); if (!b) continue;
      b.style.display = '';
      b.onclick = () => openDialog(tool);
    }
  }
  window.Publish = { open: openDialog, _toJpeg: toJpeg, _collect: collect };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
