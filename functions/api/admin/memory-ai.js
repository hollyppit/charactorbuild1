// 관리자: 기억 조각 그림용 "닮은꼴 세트" 그림을 AI(Gemini)로 만들기 (X-Admin-Hash 필요)
//  POST /api/admin/memory-ai {kind:'base', desc}                    기본 캐릭터 1장
//  POST /api/admin/memory-ai {kind:'variant', image, change}        기본 그림을 고쳐 특징만 바꾼 1장
//  → {image: 'data:image/...;base64,...'}
// 저장은 하지 않는다. 관리자 화면이 미리 보고 /api/upload + /api/items 로 저장한다.
// AI 사용은 ai_usage 에 관리자 사용으로 기록만 된다(한도 없음).
import { corsHeaders, isAdmin } from '../_lib/common.js';
import { withAiUsage } from '../_lib/ai-usage.js';

const MODELS = ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>`\\]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n);

// 아이들이 따라 그리기 쉽고, 왼쪽·오른쪽 특징이 또렷한 기본 캐릭터
const BASE = desc => `Create ONE character illustration for a children's memory drawing game.
Character: ${desc || 'a cheerful kid with a unique outfit'}.

STRICT RULES:
- Exactly one character, standing straight and facing the viewer, arms slightly away from the body.
- The FULL body from the top of the head to the feet must be visible, centered, with a small margin around it.
- Plain pure white background. No scenery, no floor, no shadow, no other objects except what the character holds.
- Flat bright colors with thick clean black outlines. Simple shapes that kids can copy.
- Make these details large and clearly visible:
  * hair clearly parted on the character's LEFT side (viewer's right),
  * one clearly visible round black mole (beauty mark) on the character's LEFT cheek (viewer's right),
  * a simple item held in the character's RIGHT hand (viewer's left),
  * a shirt with one simple bold pattern, plain-colored pants or skirt, and colored shoes.
- No text, no letters, no numbers, no logos.
- Safe for all ages, child-friendly. Not based on any existing franchise character.`;

const VARIANT = change => `Edit this illustration. Change ONLY this one thing:
"${change}"

STRICT RULES:
- Keep EVERYTHING else exactly identical: same character, same face, same hairstyle, same colors, same clothes, same pose, same size and position, same white background, same art style and outlines.
- Make the change BIG and OBVIOUS: a child must notice it at a glance even in a small thumbnail. Never make a subtle or tiny change. If the change adds or replaces an item, draw it large with a strong contrasting color.
- Do not add or remove anything else. Do not mirror or flip the whole image.
- No text, no letters. Safe for all ages.`;

async function handle({ request, env }) {
  const cors = { ...corsHeaders(request, env, 'POST,OPTIONS'), 'Content-Type': 'application/json' };
  const reply = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: cors });
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  const KEY = env.GEMINI_KEY || env.GEMINI_API_KEY;
  if (!KEY) return reply({ error: 'AI 키가 설정되지 않았어요.' }, 503);
  let b; try { b = await request.json(); } catch { return reply({ error: 'invalid_json' }, 400); }

  let parts;
  if (b.kind === 'base') {
    parts = [{ text: BASE(clean(b.desc, 200)) }];
  } else if (b.kind === 'variant') {
    const change = clean(b.change, 300);
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
    if (!m || !change) return reply({ error: '기본 그림과 바꿀 내용이 필요해요.' }, 400);
    parts = [{ inlineData: { mimeType: m[1], data: m[2] } }, { text: VARIANT(change) }];
  } else return reply({ error: 'kind 는 base 또는 variant 예요.' }, 400);

  // 비용을 아끼려고 모델을 동시에 부르지 않고 차례로 시도
  let last = '';
  for (const model of MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } } }),
      });
      if (!res.ok) { last = model + ' ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200); continue; }
      const d = await res.json();
      const img = (d.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!img) { last = model + ' 그림 없음'; continue; }
      return reply({ image: `data:${img.inlineData.mimeType};base64,${img.inlineData.data}` });
    } catch (e) { last = model + ' ' + String(e && e.message || e).slice(0, 200); }
  }
  const depleted = /credits are depleted/i.test(last);
  return reply({ error: depleted ? 'AI 크레딧이 떨어졌어요. Google AI Studio 결제를 확인해 주세요.' : 'AI 그림을 만들지 못했어요. 잠시 뒤 다시 해 보세요.', detail: last.slice(0, 300) }, 502);
}

const wrapped = withAiUsage('image', handle);
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'OPTIONS' && !isAdmin(request, env)) {
    const cors = { ...corsHeaders(request, env, 'POST,OPTIONS'), 'Content-Type': 'application/json' };
    return new Response(JSON.stringify({ error: 'admin_required' }), { status: 403, headers: cors });
  }
  return wrapped(context);
}
