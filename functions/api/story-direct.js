// 스토리 만들기 — AI 자동 영상 편집: 장면별 연출표(카메라·전환·강조·BGM) 생성/수정
// 1순위 Gemini → 실패 시 OpenAI 폴백. 결과는 화면이 그대로 그릴 수 있는 JSON(허용값만)으로 정리해서 돌려줌
const CAMS = ['zoomIn', 'zoomOut', 'panL', 'panR', 'panUp', 'panDown', 'still'];
const TRANS = ['fade', 'slide', 'zoom', 'none'];
const EMPH = ['pop', 'shake', 'none'];
const BGMS = ['calm', 'happy', 'adventure', 'mystery', 'sad', 'epic', 'none'];

export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const body = await context.request.json();
    const GEMINI_KEY = context.env.GEMINI_KEY || context.env.GEMINI_API_KEY;
    const OPENAI_KEY = context.env.OPENAI_API_KEY;
    const clip = (v, n) => String(v || '').slice(0, n);

    const pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 40)
      .map(p => ({ k: clip(p.k, 40), tag: clip(p.tag, 40), text: clip(p.text, 600), cover: !!p.cover }))
      .filter(p => p.k);
    if (!pages.length) throw new Error('연출할 장면이 없어요.');
    const title = clip(body.title, 80);
    const logline = clip(body.logline, 400);
    const feedback = clip(body.feedback, 300).trim();
    const prev = body.prev && typeof body.prev === 'object' ? JSON.stringify(body.prev).slice(0, 12000) : '';
    const wantBgm = body.bgm !== false;

    const prompt = `당신은 어린이·청소년 그림책을 짧은 영상으로 만드는 영상 편집자입니다.
각 장면(정지 그림 + 자막)의 카메라 움직임, 장면 전환, 강조할 단어, 배경음악 분위기를 정해 연출표를 만드세요.

작품 제목: ${title || '(미정)'}
로그라인: ${logline || '(없음)'}

장면 목록(JSON, k는 장면 식별자):
${JSON.stringify(pages)}

${prev ? `현재 연출표(JSON):\n${prev}\n` : ''}${feedback ? `사용자 수정 요청: "${feedback}"\n→ 요청한 부분만 바꾸고 나머지는 현재 연출표를 그대로 유지하세요.\n` : ''}
허용 값:
- cam(카메라): ${CAMS.join(' | ')}  (zoomIn=천천히 다가감, zoomOut=물러남, panL/panR/panUp/panDown=그 방향으로 이동, still=고정)
- fx, fy: 카메라 줌의 초점. 그림에서 보여 주고 싶은 곳의 위치(0~100, 가로/세로 %). 모르면 50
- trans(이 장면으로 들어올 때 전환): ${TRANS.join(' | ')}
- emph: 자막에서 강조할 단어 0~2개 (자막 원문에 있는 그대로의 단어, 감탄·핵심 단어 위주)
- emphFx: ${EMPH.join(' | ')} (pop=톡 튀어나옴, shake=떨림)
- pause: 장면 끝에 더 머무를 초(0~2). 큰 반전·감정 장면에만 1~2
- bgm(작품 전체 배경음악 분위기): ${BGMS.join(' | ')}${wantBgm ? '' : ' — 이번에는 반드시 none'}

규칙:
- 표지(cover=true)는 trans를 none으로, 천천히 zoomIn 정도만 씁니다.
- 같은 cam이 3번 이상 연달아 나오지 않게 다양하게 섞고, 이야기 흐름(긴장·절정·마무리)에 어울리게 정합니다.
- 클라이맥스에는 zoomIn+pop, 차분한 장면에는 still/pan+fade, 장면이 크게 바뀔 때는 slide를 씁니다.
- 모든 장면에 같은 전환만 쓰지 말고, 전환은 과하지 않게 합니다.
- 글자가 없는 장면은 emph를 비웁니다.

반드시 다음 JSON만 출력:
{"bgm":"calm","pages":[{"k":"장면식별자","cam":"zoomIn","fx":50,"fy":50,"trans":"fade","emph":[],"emphFx":"none","pause":0}],"note":"연출 의도 한 줄 요약"}
(입력한 모든 k를 빠짐없이 포함)`;

    const raw = await generateJson(prompt, GEMINI_KEY, OPENAI_KEY);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed || !Array.isArray(parsed.pages)) throw new Error('AI 응답을 해석하지 못했어요.');

    const byK = new Map(parsed.pages.map(p => [String(p.k), p]));
    const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
    const pick = (v, list, d) => list.includes(v) ? v : d;
    const plan = {
      bgm: wantBgm ? pick(parsed.bgm, BGMS, 'calm') : 'none',
      note: clip(parsed.note, 200),
      pages: pages.map(pg => {
        const o = byK.get(pg.k) || {};
        const emph = (Array.isArray(o.emph) ? o.emph : []).map(w => clip(w, 20).trim())
          .filter(w => w && pg.text.includes(w)).slice(0, 2);
        return {
          k: pg.k,
          cam: pick(o.cam, CAMS, pg.cover ? 'zoomIn' : 'still'),
          fx: num(o.fx, 0, 100, 50), fy: num(o.fy, 0, 100, 50),
          trans: pg.cover ? 'none' : pick(o.trans, TRANS, 'fade'),
          emph, emphFx: emph.length ? pick(o.emphFx, EMPH, 'pop') : 'none',
          pause: num(o.pause, 0, 2, 0),
        };
      }),
    };
    return new Response(JSON.stringify({ plan }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

async function generateJson(prompt, GEMINI_KEY, OPENAI_KEY) {
  let lastError = '';

  if (GEMINI_KEY) {
    for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash']) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
          }),
        });
        if (!res.ok) throw new Error(`[${model}] ${res.status}`);
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!text.trim()) throw new Error(`[${model}] 빈 응답`);
        return text;
      } catch (e) { lastError += e.message + ' | '; }
    }
  } else {
    lastError += 'GEMINI 키 없음 | ';
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`[openai] ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text.trim()) throw new Error('[openai] 빈 응답');
    return text;
  } catch (e) { lastError += e.message; }

  throw new Error('AI 요청에 실패했어요. 잠시 후 다시 시도해 주세요. (' + lastError.slice(0, 200) + ')');
}
