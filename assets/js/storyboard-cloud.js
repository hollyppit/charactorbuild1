// 스토리보드 ↔ 계정 저장 어댑터. cloud-tool.js 다음에 불러온다.
// 스케치(그림), 닮은꼴 사진, 장르, 장면 설명, 마지막 AI 결과를 저장한다. 그림·사진은 파일로 따로 올린다.
// index.html 전역(sbCtx, sbCharPhotoB64, sbGenre, selSBGenre, clearSBChar, showSBResult 등)을 사용하며 도구 코드는 수정하지 않는다.
(function () {
  if (!window.CloudTool) return;
  const U = CloudTool.util;
  const $ = id => document.getElementById(id);
  const OK_IMG = /^image\/(png|jpeg|webp|gif)$/;
  let lastResult = null;     // 마지막 AI 결과 (data: 또는 http 주소)
  let tool = null;

  function showResultBtn() {
    const b = $('btnSbCloudResult'); if (b) b.style.display = lastResult && tool && tool.bound ? '' : 'none';
  }

  async function imageBlobFrom(src, max) {
    if (!src) return null;
    if (src.startsWith('data:')) {
      const m = /^data:([^;,]+)/.exec(src);
      if (m && OK_IMG.test(m[1]) && src.length < 9 * 1024 * 1024) return U.dataUrlToBlob(src);
      return U.shrinkImage(src, max);
    }
    try {
      const r = await fetch(src);
      if (!r.ok) return null;
      const b = await r.blob();
      if (OK_IMG.test(b.type) && b.size <= 10 * 1024 * 1024) return b;
      const u = URL.createObjectURL(b);
      try { return await U.shrinkImage(u, max); } finally { URL.revokeObjectURL(u); }
    } catch (e) { return null; }   // 다른 사이트 그림이라 가져올 수 없으면 결과는 빼고 저장
  }

  async function buildState(ctx) {
    const c = $('sbCanvas');
    if (!c || !c.width) throw new Error('스토리보드 캔버스가 준비되지 않았어요.');
    const sketchBlob = await U.canvasToBlob(c, 'image/png');
    if (!sketchBlob) throw new Error('스케치를 이미지로 만들지 못했어요.');
    const sketch = await ctx.upload(sketchBlob);
    let charPhoto = null, result = null;
    if (sbCharPhotoB64) {
      const b = await U.shrinkImage(sbCharPhotoB64, 1600);
      if (b) charPhoto = await ctx.upload(b, sbCharPhotoB64);
    }
    if (lastResult) {
      const b = await imageBlobFrom(lastResult, 2400);
      if (b) result = await ctx.upload(b, lastResult);
    }
    const tb = await U.thumbFromCanvas(c);
    const thumbAsset = tb ? await ctx.upload(tb) : undefined;
    return {
      data: { v: 1, sketch, w: c.width, h: c.height, genre: sbGenre, desc: ($('sbSceneDesc') || {}).value || '', charPhoto, result },
      thumbAsset,
    };
  }

  async function apply(data, files) {
    await U.waitFor(() => typeof sbCtx !== 'undefined' && sbCtx && $('sbCanvas').width > 0, 5000);
    const c = $('sbCanvas');
    if (!sbCtx || !c.width) throw new Error('스토리보드 캔버스가 준비되지 않았어요.');
    const get = async id => { try { return await U.fetchAsset(files, id); } catch (e) { console.warn('파일 불러오기 실패:', e); return null; } };

    const sk = await get(data.sketch);
    sbCtx.fillStyle = '#fff'; sbCtx.fillRect(0, 0, c.width, c.height);
    if (sk) { const bmp = await createImageBitmap(sk); sbCtx.drawImage(bmp, 0, 0, c.width, c.height); if (bmp.close) bmp.close(); }
    sbHistory = []; sbRedo = [];

    const genreBtn = document.querySelector('.sb-genre-btn[data-genre="' + String(data.genre || 'action').replace(/[^a-z]/g, '') + '"]')
      || document.querySelector('.sb-genre-btn[data-genre="action"]');
    if (genreBtn) selSBGenre(genreBtn);
    const d = $('sbSceneDesc'); if (d) d.value = String(data.desc || '').slice(0, 200);

    clearSBChar();
    if (data.charPhoto) {
      const b = await get(data.charPhoto);
      if (b) {
        sbCharPhotoB64 = await U.blobToDataUrl(b);
        const area = $('sbCharPreviewArea');
        area.innerHTML = '';
        const im = document.createElement('img'); im.className = 'sb-char-preview'; im.alt = '캐릭터 사진'; im.src = sbCharPhotoB64;
        area.appendChild(im);
        $('sbCharClearBtn').style.display = 'block';
      }
    }
    lastResult = null;
    if (data.result) { const b = await get(data.result); if (b) lastResult = await U.blobToDataUrl(b); }
    return {};
  }

  tool = CloudTool.attach({
    kind: 'storyboard', label: '스토리보드',
    ids: { save: 'btnSbCloudSave', open: 'btnSbCloudOpen', status: 'sbCloudStatus' },
    defaultTitle: () => '스토리보드',
    confirmOpenText: '지금 스토리보드 스케치가 이 작업의 내용으로 바뀌어요.\n계속할까요?',
    ensureMode: () => U.switchTo('storyboard'),
    ready: () => U.waitFor(() => typeof sbCtx !== 'undefined' && !!sbCtx, 3000),
    validate: d => !!d && d.v === 1 && typeof d.sketch === 'string',
    buildState, apply,
    onBind: () => setTimeout(showResultBtn, 0),
    afterSave: showResultBtn,
    watch: touch => {
      const panel = $('panel-storyboard');
      if (panel) {
        panel.addEventListener('pointerup', e => { if (e.target && e.target.id === 'sbCanvas') touch(); });
        panel.addEventListener('click', e => { if (e.target.closest('button')) touch(); });
        panel.addEventListener('input', e => { if (e.target.id === 'sbSceneDesc') touch(); });
        panel.addEventListener('change', e => { if (e.target.id === 'sbCharInput') setTimeout(touch, 300); });
      }
      document.addEventListener('paste', () => { if (typeof currentMode !== 'undefined' && currentMode === 'storyboard') setTimeout(touch, 500); });
      // AI 결과가 나오면 기억해 두고 저장 예약
      if (typeof window.showSBResult === 'function') {
        const orig = window.showSBResult;
        window.showSBResult = function (url) { lastResult = url || null; const r = orig.apply(this, arguments); touch(); showResultBtn(); return r; };
      }
      const rb = $('btnSbCloudResult');
      if (rb) rb.onclick = () => { if (lastResult) showSBResult(lastResult); };
    },
  });
  tool.getLastResult = () => lastResult;   // 게시하기(publish.js)에서 사용
  window.StoryboardCloud = tool;
})();
