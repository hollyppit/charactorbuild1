export async function onRequest(context) {
  const SUPABASE_URL = context.env.SUPABASE_URL;
  const SUPABASE_KEY = context.env.SUPABASE_ANON_KEY;
  const { request } = context;
  const method = request.method;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation,resolution=merge-duplicates'
  };

  if (method === 'GET') {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/char_items?order=category,sort_order`, { headers });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (method === 'POST') {
    const body = await request.json();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/char_items`, {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (method === 'PUT') {
    const body = await request.json();
    const { id, ...rest } = body;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/char_items?id=eq.${id}`, {
      method: 'PATCH', headers, body: JSON.stringify(rest)
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (method === 'DELETE') {
    const { id } = await request.json();
    await fetch(`${SUPABASE_URL}/rest/v1/char_items?id=eq.${id}`, { method: 'DELETE', headers });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
