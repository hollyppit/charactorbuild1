// 스토리 만들기 — 나레이션 음성(Gemini TTS)
// 응답: { pcm: base64(16bit little-endian 모노 PCM), rate: 24000 }
const VOICES = ['Kore', 'Puck', 'Charon', 'Leda', 'Aoede', 'Sulafat', 'Zephyr'];

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
    if (!GEMINI_KEY) throw new Error('GEMINI 키가 설정되지 않았어요.');

    const text = String(body.text || '').trim().slice(0, 700);
    if (!text) throw new Error('읽을 글이 없어요.');
    const voice = VOICES.includes(body.voice) ? body.voice : 'Sulafat';
    const prompt = `어린이 그림책을 읽어 주는 다정한 나레이터처럼, 또박또박 천천히 감정을 담아 읽어 주세요:\n${text}`;

    let lastError = '';
    for (const model of ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
        });
        if (res.status === 429) { lastError += `[${model}] 요청 한도 `; continue; }
        if (!res.ok) throw new Error(`[${model}] ${res.status}`);
        const data = await res.json();
        const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
        if (!part) throw new Error(`[${model}] 음성 없음`);
        const mime = part.inlineData.mimeType || '';
        const m = mime.match(/rate=(\d+)/);
        return new Response(JSON.stringify({ pcm: part.inlineData.data, rate: m ? Number(m[1]) : 24000 }), { headers: corsHeaders });
      } catch (e) { lastError += e.message + ' | '; }
    }
    const err = new Error('음성 생성에 실패했어요. (' + lastError.slice(0, 160) + ')');
    err.status = /한도/.test(lastError) ? 429 : 500;
    throw err;
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: err.status || 500, headers: corsHeaders });
  }
}
