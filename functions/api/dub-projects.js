export async function onRequest(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_ANON_KEY;

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  const sb = (path, opts = {}) =>
    fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...opts.headers,
      },
    });

  // GET: 모든 작품 + 장면 목록
  if (request.method === 'GET') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: 'missing_env', SUPABASE_URL: !!SUPABASE_URL, SUPABASE_KEY: !!SUPABASE_KEY }, 500);
    const [projRes, sceneRes] = await Promise.all([
      sb('/rest/v1/dub_projects?select=id,title,order_num,created_at&order=order_num.asc,created_at.asc'),
      sb('/rest/v1/dub_scenes?select=id,project_id,name,scene_text,media_type,media_data,text_style,order_num&order=order_num.asc'),
    ]);
    const projects = await projRes.json();
    const scenes = await sceneRes.json();
    if (!Array.isArray(projects)) return json({ error: 'db_error', projStatus: projRes.status, sceneStatus: sceneRes.status, detail: projects, scenes }, 500);
    for (const p of projects) {
      p.scenes = Array.isArray(scenes) ? scenes.filter(s => s.project_id === p.id) : [];
    }
    return json(projects);
  }

  // POST: 작품 + 장면 upsert (관리자 전용)
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const { project, scenes } = body;
    if (!project || !project.id || !project.title) return json({ error: 'missing_fields' }, 400);

    // 작품 upsert
    const pRes = await sb('/rest/v1/dub_projects', {
      method: 'POST',
      headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
      body: JSON.stringify({ id: project.id, title: project.title, order_num: project.order_num || 0 }),
    });
    if (!pRes.ok) return json({ error: 'project_save_failed' }, 500);

    // 기존 장면 삭제 후 재삽입
    await sb(`/rest/v1/dub_scenes?project_id=eq.${encodeURIComponent(project.id)}`, { method: 'DELETE' });
    if (Array.isArray(scenes) && scenes.length > 0) {
      const sceneRows = scenes.map((s, i) => ({
        id: s.id,
        project_id: project.id,
        name: s.name || '',
        scene_text: s.scene_text || '',
        media_type: s.media_type || null,
        media_data: s.media_data || null,
        text_style: s.text_style ? JSON.stringify(s.text_style) : null,
        order_num: i,
      }));
      const sRes = await sb('/rest/v1/dub_scenes', {
        method: 'POST',
        body: JSON.stringify(sceneRows),
      });
      if (!sRes.ok) return json({ error: 'scenes_save_failed' }, 500);
    }
    return json({ ok: true });
  }

  // DELETE: 작품 삭제 (장면은 CASCADE)
  if (request.method === 'DELETE') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
    const { id } = body;
    if (!id) return json({ error: 'missing_id' }, 400);
    await sb(`/rest/v1/dub_projects?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
