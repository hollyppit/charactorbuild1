// 스토리 만들기 — 텍스트 AI (대본 다듬기 / 질문별 힌트)
// 1순위 Gemini → 실패 시 OpenAI 폴백
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
    const task = body.task === 'hint' ? 'hint' : 'polish';
    const mode = body.mode === 'long' ? 'long' : 'short';
    const title = clip(body.title, 80);
    const context_ = clip(body.context, 3000);

    let prompt;
    if (task === 'polish') {
      const logline = clip(body.logline, 400);
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30)
        .map(it => ({
          i: Number(it.i),
          step: clip(it.step, 60),
          question: clip(it.question, 200),
          text: clip(it.text, 600),
        }))
        .filter(it => Number.isFinite(it.i));
      if (!items.length) throw new Error('다듬을 장면이 없어요.');
      if (!logline && !items.some(it => it.text.trim())) throw new Error('로그라인이나 대본 초안을 먼저 입력해 주세요.');
      prompt = `당신은 어린이·청소년 그림책 편집자입니다. 장면별 대본을 작성하거나 다듬어 주세요.

작품 제목: ${title || '(미정)'}
로그라인(전체 이야기를 관통하는 한 문장): ${logline || '(없음 — 초안과 설정만으로 판단)'}
${context_ ? `\n누적된 기획 내용:\n${context_}\n` : ''}
각 장면에는 단계 이름(step)과 그 단계의 질문(question)이 있고, 학생의 초안(text)이 있을 수도 비어 있을 수도 있습니다.

규칙:
- text가 비어 있으면: 로그라인과 기획 내용, 그 장면의 step·question, 앞 장면과의 흐름을 바탕으로 대본을 새로 씁니다.
- text가 있으면: 학생이 쓴 사건·인물·감정·핵심 아이디어를 바꾸거나 새로 추가하지 말고, 맞춤법과 어색한 문장을 고쳐 더 생생하게 다듬습니다.
- 모든 장면이 로그라인으로 자연스럽게 이어지고 단계 순서대로 개연성이 있어야 합니다.
- 각 장면은 그림 한 장으로 그릴 수 있는 1~3문장, 쉽고 생생한 문장으로 씁니다. 초안이 있는 장면은 원문 길이의 1.5배를 넘기지 않습니다.
- 모든 장면의 말투와 시점을 통일합니다.
- 안전하고 모든 연령에 적합한 표현만 사용합니다.

장면 목록(JSON):
${JSON.stringify(items)}

반드시 다음 JSON만 출력: {"items":[{"i":번호,"text":"완성한 대본"}]}  (입력과 같은 i 값을 그대로 사용, 모든 장면 포함)`;
    } else {
      const question = clip(body.question, 200);
      const tip = clip(body.tip, 500);
      const guide = clip(body.guide, 800);
      const current = clip(body.current, 400);
      prompt = `당신은 학생의 이야기 창작을 돕는 스토리 코치입니다. 아래 질문에 대해 학생이 고를 수 있는 서로 다른 답 3가지를 제안하세요.

작품 유형: ${mode === 'long' ? '장편' : '단편'}
작품 제목: ${title || '(미정)'}
지금 질문: ${question}
질문 설명: ${tip}
${guide ? `제안 방식 지침(반드시 따를 것): ${guide}\n` : ''}${current ? `학생이 지금까지 쓴 답: ${current}\n` : ''}
지금까지 누적된 이야기 내용(앞선 내용을 포괄적으로 해석해 이어지게 할 것):
${context_ || '(아직 없음)'}

규칙:
- 3가지 제안은 서로 방향이 달라야 합니다.
- 각 제안은 학생이 그대로 답으로 써도 되는 완성된 문장(1~3문장)으로, 근거나 레퍼런스가 필요한 지침이면 그 설명을 문장 안에 짧게 녹입니다.
- 실제 작품을 인용할 때는 널리 알려진 작품만 쓰고, 확실하지 않으면 "다른 작품에서는 이런 식으로 설계해요"처럼 일반화합니다.
- 폭력·선정적 표현 없이 모든 연령에 안전하게 씁니다.

반드시 다음 JSON만 출력: {"items":["제안1","제안2","제안3"]}`;
    }

    const raw = await generateJson(prompt, GEMINI_KEY, OPENAI_KEY);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('AI 응답을 해석하지 못했어요.');

    return new Response(JSON.stringify({ items: parsed.items }), { headers: corsHeaders });
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
            generationConfig: { responseMimeType: 'application/json', temperature: 0.8 },
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

  // OpenAI 폴백
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.8,
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
