export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { image, style, mode, userPrompt: rawPrompt, regen } = await context.request.json();
    const GEMINI_KEY = context.env.GEMINI_KEY;
    const ANTHROPIC_KEY = context.env.ANTHROPIC_API_KEY;
    const base64 = image.includes(',') ? image.split(',')[1] : image;

    // 서버 측 안전 순화 (클라이언트 우회 방어)
    const userPrompt = (() => {
      if (!rawPrompt) return '';
      let t = String(rawPrompt).slice(0, 200);
      const swaps = [
        [/nude|naked|나체|알몸|벗은|노출/gi, 'character'],
        [/sex(?:ual)?|야한|섹시|섹스|에로/gi, 'cute'],
        [/porn\w*|포르노|야동/gi, 'illustration'],
        [/blood\w*|gore|gory|혈흔|내장/gi, 'colorful'],
        [/kill\w*|murder\w*|죽이|살인|폭력|학살/gi, 'energetic'],
        [/hate|racist|혐오|차별/gi, 'friendly'],
        [/(?:disney|ghibli|pixar|marvel|nintendo|pokemon)/gi, ''],
        [/(?:디즈니|지브리|픽사|마블|닌텐도|포켓몬)/gi, ''],
        [/\b(?:gun|rifle|pistol|grenade|bomb)\b|총기|폭탄|수류탄/gi, 'tool'],
        [/drug|마약|마리화나/gi, ''],
        [/suicide|자살|자해/gi, ''],
        [/weapon|무기/gi, 'item'],
        [/nsfw|18\+/gi, ''],
      ];
      swaps.forEach(([pat, rep]) => { t = t.replace(pat, rep); });
      t = t.replace(/\s{2,}/g, ' ').trim();
      return t.length >= 2 ? t : '';
    })();

    let finalPrompt = '';
    let useImageInput = true; // Gemini 호출 시 원본 이미지 첨부 여부

    if (regen) {
      // 재생성 모드: 이미 완성된 AI 결과 이미지를 부분 편집
      const instruction = userPrompt || 'improve the image slightly';
      finalPrompt = `You are editing an already-finished illustration. Follow this user instruction and change ONLY what it asks to change:

USER INSTRUCTION: "${instruction}"

STRICT RULES:
- Keep the character 100% identical: same face, same hairstyle, same hair color, same eyes, same outfit, same pose, same body proportions.
- Keep the exact same art style, rendering, color palette, and lighting as the reference image.
- Only modify the specific element the user mentioned (e.g. if they say "change the background to a forest", ONLY change the background; leave the character untouched).
- If the instruction is ambiguous, make the smallest possible change.
- Do NOT redraw the whole image. This is a targeted edit, not a regeneration.
- Output must look like the same artwork with just the requested tweak.

Safe for all ages, no violence, no sexual content.`;
      useImageInput = true; // 결과 이미지를 편집 베이스로 사용
    } else if (mode === 'dressup') {
      useImageInput = false; // 분석 결과로 텍스트만 보내 스타일 변환 일관성 확보
      let sceneDesc = 'a cute character in a scenic environment';

      const userContextNote = userPrompt
        ? `\n\nAdditional context from the user about this drawing: "${userPrompt}". Use this to better understand what you are looking at.`
        : '';

      const ANALYZE_PROMPT = `Analyze this image and describe the character and scene in real-world terms only. Do NOT describe the art style, drawing technique, or visual rendering method. Describe only the physical subject matter as if it were real.

CHARACTER (describe as a real being, not as a drawing):
- Species/creature type and body build (e.g. "young human female, slim build, about 160cm tall" — NOT "anime girl")
- Hair: exact color, length, style, texture
- Eye color and general shape/expression
- Skin tone
- Outfit: every clothing item with exact colors, style, patterns, accessories
- Pose: body position, arm/leg placement, facing direction
- Facial expression and emotion

BACKGROUND:
- Real-world environment and setting (e.g. "sandy beach with palm trees, clear blue sky")
- Time of day and natural lighting
- Key visual elements and atmosphere

Output ONLY these two sections in English. No intro sentences. Do NOT mention: anime, cartoon, cel-shading, illustration, drawing, art style, or any rendering technique. Max 220 words.${userContextNote}`;

      // 1순위: OpenAI Vision
      try {
        const OPENAI_KEY = context.env.OPENAI_API_KEY;
        const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_KEY}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 450,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } },
                { type: 'text', text: ANALYZE_PROMPT }
              ]
            }]
          })
        });
        if (oaiRes.ok) {
          const oaiData = await oaiRes.json();
          const result = oaiData.choices?.[0]?.message?.content || '';
          if (result.length > 20) {
            sceneDesc = result;
            console.log('OpenAI 분석 성공');
          } else throw new Error('응답 너무 짧음');
        } else throw new Error(`OpenAI ${oaiRes.status}`);
      } catch(e) {
        console.warn('OpenAI 분석 실패, Claude로 폴백:', e.message);

        // 2순위: Claude Vision 폴백
        try {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 450,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
                  { type: 'text', text: ANALYZE_PROMPT }
                ]
              }]
            })
          });
          if (claudeRes.ok) {
            const claudeData = await claudeRes.json();
            const result = claudeData.content?.[0]?.text || '';
            if (result.length > 20) {
              sceneDesc = result;
              console.log('Claude 분석 성공');
            } else throw new Error('응답 너무 짧음');
          } else throw new Error(`Claude ${claudeRes.status}`);
        } catch(e2) {
          console.warn('Claude 분석도 실패, 기본값 사용:', e2.message);
        }
      }

      const styleInstructions = {
  cartoon: `STYLE: ANIME / MANGA ILLUSTRATION ONLY. Do NOT use realistic photography, 3D CGI, or painted brushstroke style.

Generate a high-quality anime illustration of the character described below. Match ALL visual details exactly.

CHARACTER DETAILS:
${sceneDesc}

Required art style: Studio Ghibli / modern Japanese anime. Large expressive eyes, vibrant cel-shading, clean crisp line art, painterly anime background, dramatic color palette. The character's colors, outfit, and pose must precisely match the description above.`,

  '3d': `STYLE: PIXAR 3D CGI RENDER ONLY. Do NOT use anime illustration, realistic photography, or painted brushstroke style.

Generate a Pixar-style 3D CGI render of the character described below. Match ALL visual details exactly.

CHARACTER DETAILS:
${sceneDesc}

Required art style: Pixar / Illumination CGI movie quality. Subsurface skin/fur scattering, volumetric cinematic lighting, ray-traced shadows, smooth polished 3D surfaces. The character's colors, outfit, and pose must precisely match the description above.`,

  realistic: `CRITICAL: Generate a 100% PHOTOREALISTIC PHOTOGRAPH. The reference image is a stylized illustration — completely IGNORE its art style. Do NOT reproduce any illustrated, anime, cartoon, or drawn visual elements. The final output must look like a real photograph taken with a camera.

Generate a hyper-realistic cinematic photograph of the character described below. Both character AND background must be indistinguishable from a real photograph.

CHARACTER DETAILS:
${sceneDesc}

Required photographic style: Shot on RED Cinema camera, anamorphic lens, f/1.4 aperture. Real human skin texture, natural hair, realistic eyes (NOT anime-style). Cinematic color grading, subtle film grain, volumetric natural lighting, shallow depth of field with bokeh. 8K HDR. The result must look like a professional photograph of a real person, not an illustration.`,

  painting: `STYLE: OIL PAINTING / FINE ART ONLY. Do NOT use anime illustration, 3D CGI render, or realistic photography style.

Generate a museum-quality oil painting of the character described below. Match ALL visual details exactly.

CHARACTER DETAILS:
${sceneDesc}

Required art style: Impressionist master painting. Bold visible brushstrokes like Van Gogh, rich impasto texture, emotional color palette, dramatic painterly light and shadow, visible canvas texture. Fine art gallery quality. The character's colors, pose, and setting must precisely match the description above.`,
};

      const userCustomization = userPrompt
        ? `\n\nUSER CUSTOMIZATION (HIGHEST PRIORITY): "${userPrompt}". Apply this instruction to the character — change the outfit, clothing, setting, or appearance as described. This overrides the original character's clothing and accessories.`
        : '';

      finalPrompt = styleInstructions[style] || styleInstructions.cartoon;
      finalPrompt += userCustomization;

      const safetyLine = "\n\nIMPORTANT: Output in vertical portrait orientation (9:16 aspect ratio, mobile phone optimized). Full body composition, safe for all ages, no violence, no sexual content, child-friendly illustration.";
      finalPrompt += safetyLine;

    } else {
      const userDescLine = userPrompt
        ? `\n\nUSER CUSTOMIZATION (HIGHEST PRIORITY): "${userPrompt}". Apply this to the character — change the outfit, clothing, setting, or appearance as described. This overrides the original character's clothing and accessories.`
        : '';

      const styleMap = {
        cartoon: `STYLE: ANIME / MANGA ILLUSTRATION ONLY. Do NOT use realistic photography, 3D CGI, or painted brushstroke style.

Completely redraw this image as a high-quality anime illustration. Use the reference image for subject and composition only — render the final result entirely in Japanese anime / Studio Ghibli style. Large expressive eyes, vibrant cel-shading, clean crisp line art, colorful anime background, high detail digital art.${userDescLine}`,

        '3d': `STYLE: PIXAR 3D CGI RENDER ONLY. Do NOT use anime illustration, realistic photography, or painted brushstroke style.

Completely recreate this image as a Pixar-style 3D CGI render. Use the reference image for subject and composition only — render the final result entirely in Pixar / Illumination CGI movie quality. Subsurface scattering, volumetric cinematic lighting, ray-traced shadows, smooth polished 3D surfaces.${userDescLine}`,

        realistic: `CRITICAL: Generate a 100% PHOTOREALISTIC PHOTOGRAPH. The reference image is a stylized illustration — completely IGNORE its art style. Do NOT reproduce any illustrated, anime, cartoon, or drawn elements. The output must look like a real photograph taken with a camera.

Transform this image into a hyper-realistic cinematic photograph. Use the reference image for subject and composition only — render everything as real photographic imagery. Real human skin, natural eyes (NOT anime-style), cinematic lighting, bokeh background, film grain, 8K detail. Shot on professional cinema camera.${userDescLine}`,

        painting: `STYLE: OIL PAINTING / FINE ART ONLY. Do NOT use anime illustration, 3D CGI render, or realistic photography style.

Repaint this image as a museum-quality oil painting masterpiece. Use the reference image for subject and composition only — render the final result entirely as an oil painting. Van Gogh impasto brushstrokes, rich textured paint layers, emotional color palette, visible canvas texture. Fine art gallery quality.${userDescLine}`,
      };
      const hardRule = `ABSOLUTE RULE: You MUST generate a completely NEW image from scratch. Do NOT return, copy, preserve, or lightly edit the reference image. The reference is ONLY for understanding subject and composition — the final image must be 100% re-rendered in the target style below. If you output anything resembling the original rendering, the task has FAILED.\n\n`;
      finalPrompt = hardRule + (styleMap[style] || styleMap.cartoon);

      const safetyLine = "IMPORTANT: Output in vertical portrait orientation (9:16 aspect ratio, mobile phone optimized). Full body composition, safe for all ages, no violence, no sexual content, child-friendly illustration.";
      finalPrompt += `\n\n${safetyLine}`;
    }

    const models = [
      'gemini-2.5-flash-image',
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.0-flash-exp-image-generation',
    ];

    let lastError = '';

    for (const model of models) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

        const parts = useImageInput
          ? [
              { inlineData: { mimeType: 'image/png', data: base64 } },
              { text: finalPrompt }
            ]
          : [
              { text: finalPrompt }
            ];

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ['IMAGE'],
              imageConfig: { aspectRatio: '9:16' },
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
