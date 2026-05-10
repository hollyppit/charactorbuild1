export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY;
  // ADMIN_PW_HASH: Cloudflare 환경변수에 SHA-256('admin1234') 값을 등록해 두세요.
  // 미등록 시 관리자 삭제 기능이 비활성화됩니다.
  const ADMIN_PW_HASH = env.ADMIN_PW_HASH || '';

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  const sb = (path, opts = {}) =>
    fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
    });

  // ── GET: 목록 또는 단건 조회 ─────────────────────────────
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (id) {
      const res = await sb(`/rest/v1/draw_saves?id=eq.${encodeURIComponent(id)}&select=*`);
      const rows = await res.json();
      if (!rows.length) return json({ error: 'not_found' }, 404);
      return json(rows[0]);
    }

    const res = await sb(
      '/rest/v1/draw_saves?select=id,user_name,password_hash,password_plain,thumbnail_url,layer_count,canvas_w,canvas_h,created_at&order=created_at.desc'
    );
    return json(await res.json());
  }

  // ── POST: 새 저장 ────────────────────────────────────────
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const { user_name, password_hash, password_plain, thumbnail, layers, canvas_w, canvas_h } = body;
    if (!user_name || !password_hash || !Array.isArray(layers) || !layers.length)
      return json({ error: 'missing_fields' }, 400);

    const saveId = crypto.randomUUID();

    // 썸네일 Storage 업로드
    let thumbnail_url = null;
    if (thumbnail) {
      const binary = _b64ToBinary(thumbnail.split(',')[1]);
      const r = await fetch(
        `${SUPABASE_URL}/storage/v1/object/draw-saves/${saveId}/thumb.jpg`,
        {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'image/jpeg',
            'x-upsert': 'true',
          },
          body: binary,
        }
      );
      if (r.ok)
        thumbnail_url = `${SUPABASE_URL}/storage/v1/object/public/draw-saves/${saveId}/thumb.jpg`;
    }

    // 레이어별 Storage 업로드
    const layers_meta = [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      let layer_url = null;

      if (layer.data) {
        const isPng = layer.kind === 'draw';
        const mimeType = isPng ? 'image/png' : 'image/jpeg';
        const ext = isPng ? 'png' : 'jpg';
        const binary = _b64ToBinary(layer.data.split(',')[1]);

        const r = await fetch(
          `${SUPABASE_URL}/storage/v1/object/draw-saves/${saveId}/layer_${i}.${ext}`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': mimeType,
              'x-upsert': 'true',
            },
            body: binary,
          }
        );
        if (r.ok)
          layer_url = `${SUPABASE_URL}/storage/v1/object/public/draw-saves/${saveId}/layer_${i}.${ext}`;
      }

      layers_meta.push({
        name: layer.name,
        kind: layer.kind,
        opacity: layer.opacity ?? 1,
        visible: layer.visible ?? true,
        locked: layer.locked ?? false,
        scale: layer.scale ?? 1,
        rotate: layer.rotate ?? 0,
        offsetX: layer.offsetX ?? 0,
        offsetY: layer.offsetY ?? 0,
        url: layer_url,
      });
    }

    // DB 레코드 삽입
    const dbRes = await sb('/rest/v1/draw_saves', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: saveId,
        user_name,
        password_hash,
        password_plain: password_plain || '',
        thumbnail_url,
        layer_count: layers.length,
        layers_meta,
        canvas_w: canvas_w || 0,
        canvas_h: canvas_h || 0,
      }),
    });

    if (!dbRes.ok) {
      const err = await dbRes.text();
      return json({ error: err }, 500);
    }

    const saved = await dbRes.json();
    return json(saved[0] || { id: saveId });
  }

  // ── PUT: 기존 저장 덮어쓰기 ─────────────────────────────
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const { id, password_hash, thumbnail, layers, canvas_w, canvas_h } = body;
    if (!id || !password_hash || !Array.isArray(layers) || !layers.length)
      return json({ error: 'missing_fields' }, 400);

    // 비밀번호 검증
    const getRes = await sb(`/rest/v1/draw_saves?id=eq.${encodeURIComponent(id)}&select=id,password_hash,layers_meta`);
    const rows = await getRes.json();
    if (!rows.length) return json({ error: 'not_found' }, 404);
    if (rows[0].password_hash !== password_hash) return json({ error: 'wrong_password' }, 403);

    // 썸네일 덮어쓰기
    let thumbnail_url = null;
    if (thumbnail) {
      const binary = _b64ToBinary(thumbnail.split(',')[1]);
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/draw-saves/${id}/thumb.jpg`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
        body: binary,
      });
      if (r.ok) thumbnail_url = `${SUPABASE_URL}/storage/v1/object/public/draw-saves/${id}/thumb.jpg`;
    }

    // 레이어 덮어쓰기
    const layers_meta = [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      let layer_url = null;
      if (layer.data) {
        const isPng = layer.kind === 'draw';
        const ext = isPng ? 'png' : 'jpg';
        const binary = _b64ToBinary(layer.data.split(',')[1]);
        const r = await fetch(`${SUPABASE_URL}/storage/v1/object/draw-saves/${id}/layer_${i}.${ext}`, {
          method: 'POST',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': isPng ? 'image/png' : 'image/jpeg', 'x-upsert': 'true' },
          body: binary,
        });
        if (r.ok) layer_url = `${SUPABASE_URL}/storage/v1/object/public/draw-saves/${id}/layer_${i}.${ext}`;
      }
      layers_meta.push({
        name: layer.name, kind: layer.kind, opacity: layer.opacity ?? 1,
        visible: layer.visible ?? true, locked: layer.locked ?? false,
        scale: layer.scale ?? 1, rotate: layer.rotate ?? 0,
        offsetX: layer.offsetX ?? 0, offsetY: layer.offsetY ?? 0, url: layer_url,
      });
    }

    // DB 업데이트
    const dbRes = await sb(`/rest/v1/draw_saves?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        thumbnail_url, layer_count: layers.length, layers_meta,
        canvas_w: canvas_w || 0, canvas_h: canvas_h || 0,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!dbRes.ok) return json({ error: await dbRes.text() }, 500);
    return json({ success: true, id });
  }

  // ── DELETE: 저장 삭제 ────────────────────────────────────
  if (request.method === 'DELETE') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

    const { id, password_hash, admin_pw_hash } = body;
    if (!id) return json({ error: 'id_required' }, 400);

    // DB에서 레코드 조회
    const getRes = await sb(
      `/rest/v1/draw_saves?id=eq.${encodeURIComponent(id)}&select=id,password_hash,layer_count,layers_meta`
    );
    const rows = await getRes.json();
    if (!rows.length) return json({ error: 'not_found' }, 404);

    const save = rows[0];

    // 권한 검증: 사용자 비밀번호 OR 관리자 비밀번호
    const isAdminAuth = ADMIN_PW_HASH && admin_pw_hash && admin_pw_hash === ADMIN_PW_HASH;
    const isUserAuth  = password_hash && password_hash === save.password_hash;

    if (!isAdminAuth && !isUserAuth) return json({ error: 'wrong_password' }, 403);

    // Storage 파일 삭제
    const filePaths = [`${id}/thumb.jpg`];
    if (Array.isArray(save.layers_meta)) {
      save.layers_meta.forEach((l, i) => {
        const ext = l.kind === 'draw' ? 'png' : 'jpg';
        filePaths.push(`${id}/layer_${i}.${ext}`);
      });
    }
    await fetch(`${SUPABASE_URL}/storage/v1/object/draw-saves`, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: filePaths }),
    });

    // DB 레코드 삭제
    await sb(`/rest/v1/draw_saves?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });

    return json({ success: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

function _b64ToBinary(b64) {
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
