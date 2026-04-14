export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { sketch, charPhoto, genre, sceneDesc: rawDesc } = await context.request.json();
    const GEMINI_KEY = context.env.GEMINI_KEY;
    const OPENAI_KEY = context.env.OPENAI_API_KEY;
    const ANTHROPIC_KEY = context.env.ANTHROPIC_API_KEY;

    const sketchBase64 = sketch.includes(',') ? sketch.split(',')[1] : sketch;

    // 장면 설명 안전 처리
    const sceneDesc = (() => {
      if (!rawDesc) return '';
      let t = String(rawDesc).slice(0, 200);
      const swaps = [
        [/nude|naked|나체|알몸|벗은|노출/gi, 'character'],
        [/sex(?:ual)?|야한|섹시|섹스|에로/gi, 'dramatic'],
        [/porn\w*|포르노|야동/gi, 'cinematic'],
        [/blood\w*|gore|gory|혈흔|내장/gi, 'intense'],
        [/kill\w*|murder\w*|죽이|살인|폭력|학살/gi, 'action'],
        [/hate|racist|혐오|차별/gi, 'emotional'],
        [/(?:disney|ghibli|pixar|marvel|nintendo|pokemon)/gi, ''],
        [/(?:디즈니|지브리|픽사|마블|닌텐도|포켓몬)/gi, ''],
        [/nsfw|18\+/gi, ''],
      ];
      swaps.forEach(([pat, rep]) => { t = t.replace(pat, rep); });
      return t.replace(/\s{2,}/g, ' ').trim();
    })();

    // ── Step 1: 스케치 장면 분석 ──
    const sceneIntentHint = sceneDesc
      ? `\n\nIMPORTANT CONTEXT: The artist described this sketch as "${sceneDesc}". Use this as the PRIMARY INTENT — interpret the sketch through this lens and expand it cinematically. For example, if they wrote "warrior with a sword", describe a warrior character armed with a sword in a dramatic action pose.`
      : '';

    const SKETCH_PROMPT = `You are a Hollywood film director analyzing a hand-drawn storyboard sketch. Your job is to interpret the sketch AND the artist's intent to describe a cinematic movie scene.${sceneIntentHint}

SCENE ANALYSIS (interpret sketch + artist's intent together):
- Main subject/character: what are they, what are they doing (informed by both the sketch and the description)
- Shot type (close-up, medium shot, wide shot, bird's eye, low angle, etc.)
- Composition: where are characters/objects positioned
- Character actions, poses, and emotional state
- Setting and environment (infer a fitting cinematic location from the description)
- Mood and atmosphere
- Key props or environmental elements (e.g., if "warrior with sword" — describe the sword, armor, battle environment)
- Suggested camera angle and movement

Output ONLY the scene description in English. Be specific and cinematic. Do NOT describe it as a drawing — describe it as if it were a real scene. Max 200 words.`;

    let sketchDesc = 'A dramatic movie scene with a character in an interesting cinematic composition';

    try {
      const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 400,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${sketchBase64}`, detail: 'low' } },
            { type: 'text', text: SKETCH_PROMPT }
          ]}]
        })
      });
      if (oaiRes.ok) {
        const d = await oaiRes.json();
        const r = d.choices?.[0]?.message?.content || '';
        if (r.length > 20) { sketchDesc = r; console.log('스케치 분석 성공 (OpenAI)'); }
        else throw new Error('응답 너무 짧음');
      } else throw new Error(`OpenAI ${oaiRes.status}`);
    } catch (e) {
      console.warn('스케치 분석 OpenAI 실패, Claude 폴백:', e.message);
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: sketchBase64 } },
              { type: 'text', text: SKETCH_PROMPT }
            ]}]
          })
        });
        if (claudeRes.ok) {
          const d = await claudeRes.json();
          const r = d.content?.[0]?.text || '';
          if (r.length > 20) { sketchDesc = r; console.log('스케치 분석 성공 (Claude)'); }
        }
      } catch (e2) { console.warn('스케치 분석 Claude 폴백도 실패:', e2.message); }
    }

    // ── Step 2: 캐릭터 사진 분석 (선택) ──
    let charDesc = '';
    if (charPhoto) {
      const charBase64 = charPhoto.includes(',') ? charPhoto.split(',')[1] : charPhoto;
      const CHAR_PROMPT = `Analyze this person's photo. Describe only their physical appearance so an AI can recreate them as a character in a movie scene.

Physical characteristics only:
- Approximate age range
- Face shape and key facial features
- Hair: color, length, style, texture
- Eye color and shape
- Skin tone
- Body build

Do NOT describe clothing or background. Output in English only. Max 100 words.`;

      try {
        const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 200,
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${charBase64}`, detail: 'low' } },
              { type: 'text', text: CHAR_PROMPT }
            ]}]
          })
        });
        if (oaiRes.ok) {
          const d = await oaiRes.json();
          const r = d.choices?.[0]?.message?.content || '';
          if (r.length > 10) { charDesc = r; console.log('캐릭터 분석 성공 (OpenAI)'); }
          else throw new Error('응답 너무 짧음');
        } else throw new Error(`OpenAI ${oaiRes.status}`);
      } catch (e) {
        console.warn('캐릭터 분석 OpenAI 실패, Claude 폴백:', e.message);
        try {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              messages: [{ role: 'user', content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: charBase64 } },
                { type: 'text', text: CHAR_PROMPT }
              ]}]
            })
          });
          if (claudeRes.ok) {
            const d = await claudeRes.json();
            const r = d.content?.[0]?.text || '';
            if (r.length > 10) { charDesc = r; console.log('캐릭터 분석 성공 (Claude)'); }
          }
        } catch (e2) { console.warn('캐릭터 분석 Claude 폴백도 실패:', e2.message); }
      }
    }

    // ── Step 3: 장르별 시네마틱 스타일 ──
    const genreStyles = {
      action: `CINEMATIC ACTION BLOCKBUSTER. High contrast dramatic lighting with deep shadows and bright highlights. Dynamic explosive atmosphere. Intense saturated colors. Motion blur on action elements. Hollywood blockbuster visual quality — like scenes from Mission Impossible or Fast & Furious.`,
      romance: `CINEMATIC ROMANCE DRAMA. Warm golden-hour lighting with soft bokeh background. Intimate emotional atmosphere. Pastel and warm amber tones. Shallow depth of field. Dreamlike soft focus quality — like scenes from a Korean drama or Notting Hill.`,
      scifi: `CINEMATIC SCI-FI / FANTASY. Futuristic or magical environment with dramatic neon lighting or otherworldly atmospheric effects. Rich detailed world-building. Vibrant accent colors against dark backgrounds. Epic scale visual composition — like scenes from Dune or Doctor Strange.`,
      thriller: `CINEMATIC THRILLER / HORROR. Dark oppressive atmosphere with extreme contrast. Long moody shadows. Desaturated palette with cold blue-gray tones. High tension visual composition. Dramatic chiaroscuro lighting — like scenes from Se7en or Parasite.`,
      historical: `CINEMATIC HISTORICAL DRAMA. Period-accurate setting with painterly natural lighting. Warm candle/firelight or golden sunlight. Rich textured costumes and authentic historical environment. Wide establishing shots. Epic scope — like scenes from The Last Samurai or The Handmaiden.`,
      animation: `CINEMATIC 3D ANIMATED FILM. High-quality Pixar/DreamWorks CGI quality. Vibrant expressive colors. Detailed animated environment with rich textures. Warm appealing character design. Movie-quality lighting and depth — like Coco or Spider-Man: Into the Spider-Verse.`,
    };

    const genreStyle = genreStyles[genre] || genreStyles.action;

    const charSection = charDesc
      ? `\n\nMAIN CHARACTER (must resemble this person):\n${charDesc}\nThe primary character in this scene must look like this person — same facial features, hair, and skin tone.`
      : '';

    const sceneSection = sceneDesc
      ? `\n\nSCENE SUBJECT & DIRECTOR'S INTENT: "${sceneDesc}" — This is what the artist intended to draw. The entire image must depict this concept cinematically. A director's interpretation: not just the literal words, but the dramatic, emotional, and visual potential of this subject in a movie scene. Do NOT render this text visibly in the image.`
      : '';

    const finalPrompt = `GENERATE A CINEMATIC MOVIE SCENE. Convert this storyboard sketch into a high-quality photorealistic film frame.

SCENE COMPOSITION (based on the sketch):
${sketchDesc}

VISUAL STYLE: ${genreStyle}${charSection}${sceneSection}

TECHNICAL REQUIREMENTS: Horizontal landscape orientation (4:3 aspect ratio, optimized for A4 landscape paper printing). Cinematic widescreen composition, professional cinematography, movie-quality lighting and depth of field. This must look like an actual frame from a major motion picture. Full scene, safe for all ages, no violence depiction, no sexual content.
CRITICAL: Do NOT include any text, words, letters, subtitles, watermarks, captions, or written labels anywhere in the image. Pure visual scene only.`;

    // ── Step 4: Gemini로 이미지 생성 ──
    const models = [
      'gemini-2.5-flash-image',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp-image-generation',
    ];

    let lastError = '';

    for (const model of models) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        const parts = [
          { inlineData: { mimeType: 'image/png', data: sketchBase64 } },
          { text: finalPrompt }
        ];
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ['IMAGE'],
              imageConfig: { aspectRatio: '4:3' },
            },
          }),
        });

        if (!res.ok) {
          const errTxt = await res.text().catch(() => '');
          throw new Error(`[${model}] ${res.status}: ${errTxt}`);
        }

        const data = await res.json();
        const parts2 = data.candidates?.[0]?.content?.parts || [];
        const imagePart = parts2.find(p => p.inlineData?.mimeType?.startsWith('image/'));

        if (!imagePart) throw new Error(`[${model}] 이미지 데이터 없음`);

        const imageDataUrl = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
        return new Response(JSON.stringify({ image: imageDataUrl }), { headers: corsHeaders });

      } catch (e) {
        lastError += e.message + ' | ';
      }
    }

    throw new Error(`모든 모델 실패: ${lastError}`);

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
}
