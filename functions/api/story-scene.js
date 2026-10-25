// 스토리 만들기 — 장면 이미지 생성/수정
// 캐릭터 레퍼런스 + 대본 기반. 1순위 Gemini → 실패 시 OpenAI(gpt-image-1) 폴백
export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const b = await context.request.json();
    const GEMINI_KEY = context.env.GEMINI_KEY || context.env.GEMINI_API_KEY;
    const OPENAI_KEY = context.env.OPENAI_API_KEY;

    const sanitize = (raw, max) => {
      if (!raw) return '';
      let t = String(raw).slice(0, max);
      const swaps = [
        [/nude|naked|나체|알몸|벗은|노출/gi, 'character'],
        [/sex(?:ual)?|야한|섹시|섹스|에로/gi, 'cute'],
        [/porn\w*|포르노|야동/gi, 'illustration'],
        [/blood\w*|gore|gory|혈흔|내장/gi, 'colorful'],
        [/kill\w*|murder\w*|죽이|살인|폭력|학살/gi, 'energetic'],
        [/hate|racist|혐오|차별/gi, 'friendly'],
        [/drug|마약|마리화나/gi, ''],
        [/suicide|자살|자해/gi, ''],
        [/nsfw|18\+/gi, ''],
      ];
      swaps.forEach(([pat, rep]) => { t = t.replace(pat, rep); });
      return t.replace(/\s{2,}/g, ' ').trim();
    };

    const script = sanitize(b.script, 600);
    const edit = sanitize(b.edit, 300);
    const storyContext = sanitize(b.context, 1500);
    const title = sanitize(b.title, 80);
    if (!script && !edit) throw new Error('대본이 비어 있어요.');

    const aspectMap = {
      '4:3': { gemini: '4:3', openai: '1536x1024', text: 'horizontal landscape (4:3)' },
      '3:4': { gemini: '3:4', openai: '1024x1536', text: 'vertical portrait (3:4)' },
      '1:1': { gemini: '1:1', openai: '1024x1024', text: 'square (1:1)' },
    };
    const aspect = b.kind === 'character' ? aspectMap['1:1'] : (aspectMap[b.aspect] || aspectMap['4:3']);

    const styleMap = {
      storybook: 'Warm children\'s picture-book illustration, soft watercolor and colored-pencil texture, gentle pastel palette, clean friendly shapes.',
      anime: 'High-quality anime / manga illustration, expressive eyes, cel-shading, clean line art, vibrant colors.',
      '3d': 'Polished 3D animated-film look, smooth surfaces, soft cinematic lighting, appealing rounded character design.',
      crayon: 'Hand-drawn crayon and oil-pastel doodle style, playful wobbly lines, bright saturated colors, paper texture.',
      flat: 'Modern flat vector illustration, bold simple shapes, limited harmonious color palette, minimal shading.',
    };
    const styleText = styleMap[b.style] || styleMap.storybook;

    const charRef = typeof b.charRef === 'string' && b.charRef.startsWith('data:') ? b.charRef : '';
    const baseImage = typeof b.baseImage === 'string' && b.baseImage.startsWith('data:') ? b.baseImage : '';

    const split = (d) => {
      const m = d.match(/^data:([^;]+);base64,(.+)$/);
      return m ? { mime: m[1], data: m[2] } : null;
    };
    const refImg = (charRef && b.kind !== 'character') ? split(charRef) : null;
    const baseImg = baseImage ? split(baseImage) : null;

    const charRule = refImg
      ? `CHARACTER CONSISTENCY (VERY IMPORTANT): The ${baseImg ? 'second' : 'first'} attached image is the main character reference sheet. The main character in this page MUST look exactly like it: same face, hair, eyes, skin tone, outfit, colors and body proportions. Do not redesign the character.`
      : 'Keep the main character design simple and consistent with the story context.';

    const isCharacter = b.kind === 'character';

    let prompt;
    if (isCharacter) {
      // 캐릭터 레퍼런스: 장면 전체 일관성의 기준이 되는 한 장짜리 캐릭터 시트
      const base = `Single main character reference image for a picture book${title ? ` titled "${title}"` : ''}.
STYLE: ${styleText} Use exactly this style, since every page of the book will be drawn in it.`;
      const rules = `- Show ONE character only, full body, centered, clear readable face, simple standing pose, plain light background (no scenery).
- Distinctive, memorable design: clear hair, outfit, colors and accessories that can be redrawn consistently on every page.
- Orientation: square (1:1). Do NOT draw any text, letters, captions, logos or watermarks. Safe for all ages.`;
      if (baseImg && edit) {
        prompt = `You are editing a character reference image. The attached image is the current character.
USER EDIT REQUEST: "${edit}"
RULES:
- Change ONLY what the request asks for; keep everything else (face, proportions, art style, pose, background) identical.
- If the request is ambiguous, make the smallest possible change.
${rules}`;
      } else {
        prompt = `${base}
CHARACTER DESCRIPTION: "${script}"
${storyContext ? `STORY CONTEXT:\n${storyContext}\n` : ''}RULES:
${rules}`;
      }
    } else if (baseImg && edit) {
      prompt = `You are editing one page of a picture book. The FIRST attached image is the current page illustration.
USER EDIT REQUEST: "${edit}"

RULES:
- Change ONLY what the request asks for. Keep composition, character design, art style, colors and lighting otherwise identical.
- ${charRule}
- If the request is ambiguous, make the smallest possible change.
- Keep the image ${aspect.text}. No text, letters, captions or watermarks in the image. Safe for all ages.`;
    } else {
      prompt = `Create ONE full-page illustration for a children's picture book${title ? ` titled "${title}"` : ''}.

STYLE: ${styleText} Use exactly this same style on every page of the book.
${charRule}
${storyContext ? `\nSTORY SO FAR (for continuity of setting and characters):\n${storyContext}\n` : ''}
THIS PAGE (page ${Number(b.pageNo) || 1}${b.total ? ` of ${Number(b.total)}` : ''}) — illustrate this scene:
"${script}"

RULES:
- Compose the scene clearly: main character prominent, expressive pose and emotion matching the script, environment matching the story setting.
- Orientation: ${aspect.text}.
- Do NOT draw any text, letters, speech-bubble words, captions, logos or watermarks.
- Safe for all ages: no violence, no sexual content, child-friendly.`;
    }

    // 이미지 입력 순서: [편집 베이스] → [캐릭터 레퍼런스]
    const inputs = [];
    if (baseImg && edit) inputs.push(baseImg);
    if (refImg) inputs.push(refImg);

    let lastError = '';

    // ── Gemini ──
    if (GEMINI_KEY) {
      const parts = inputs.map(im => ({ inlineData: { mimeType: im.mime, data: im.data } }));
      parts.push({ text: prompt });
      for (const model of ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']) {
        try {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect.gemini } },
            }),
          });
          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`[${model}] ${res.status}: ${t.slice(0, 200)}`);
          }
          const data = await res.json();
          const img = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.mimeType?.startsWith('image/'));
          if (!img) throw new Error(`[${model}] 이미지 데이터 없음`);
          return new Response(JSON.stringify({ image: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}`, engine: 'gemini' }), { headers: corsHeaders });
        } catch (e) { lastError += e.message + ' | '; }
      }
    } else {
      lastError += 'GEMINI 키 없음 | ';
    }

    // ── OpenAI 폴백 ──
    try {
      let res;
      if (inputs.length) {
        const fd = new FormData();
        inputs.forEach((im, i) => {
          const bin = atob(im.data);
          const bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          const ext = im.mime.includes('png') ? 'png' : im.mime.includes('webp') ? 'webp' : 'jpg';
          fd.append('image[]', new Blob([bytes], { type: im.mime }), `ref${i}.${ext}`);
        });
        fd.append('prompt', prompt.slice(0, 30000));
        fd.append('model', 'gpt-image-1');
        fd.append('size', aspect.openai);
        fd.append('n', '1');
        res = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: fd,
        });
      } else {
        res = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({ model: 'gpt-image-1', prompt: prompt.slice(0, 30000), size: aspect.openai, n: 1 }),
        });
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`[openai] ${res.status}: ${t.slice(0, 200)}`);
      }
      const b64 = (await res.json()).data?.[0]?.b64_json;
      if (!b64) throw new Error('[openai] 이미지 데이터 없음');
      return new Response(JSON.stringify({ image: `data:image/png;base64,${b64}`, engine: 'openai' }), { headers: corsHeaders });
    } catch (e) { lastError += e.message; }

    throw new Error('장면 생성에 실패했어요. 잠시 후 다시 시도해 주세요.\n' + lastError.slice(0, 400));
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
