export async function onRequest(context) {
  const SUPABASE_URL = context.env.SUPABASE_URL;
  const SUPABASE_KEY = context.env.SUPABASE_ANON_KEY;
  const { request } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const { fileName, fileData, mimeType } = await request.json();
  const base64 = fileData.split(',')[1];
  const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/char-assets/${fileName}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': mimeType || 'image/png',
      'x-upsert': 'true'
    },
    body: binary
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    return new Response(JSON.stringify({ error: err }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/char-assets/${fileName}`;
  return new Response(JSON.stringify({ url: publicUrl }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
