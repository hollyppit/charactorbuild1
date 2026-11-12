// 비활성화됨: 요청 본문을 그대로 Anthropic API에 전달하는 열린 프록시였고,
// 현재 클라이언트(index.html)에서 호출하지 않는다. 비용 남용 방지를 위해 막아 둔다.
// 필요해지면 인증·모델/토큰 제한·사용량 기록을 갖춘 전용 엔드포인트로 새로 만든다.
export async function onRequest() {
  return new Response(JSON.stringify({ error: 'endpoint_disabled' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  });
}
