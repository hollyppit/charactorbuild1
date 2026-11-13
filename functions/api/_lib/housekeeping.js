// 보관 기간이 지난 소셜 기록 정리 (라우트 아님). 개인정보 처리방침 4조와 맞춘다.
//  - 삭제한 게시물 기록: 삭제 후 30일 (그림 파일은 삭제할 때 이미 지움)
//  - 지운 댓글 내용: 지운 뒤 30일
//  - 처리 끝난 신고: 처리 후 1년
//  - 끝나거나 해제된 이용 제한(경고 포함): 1년
//  (알림 90일·AI 이용 기록 90일은 DB 함수가 따로 정리)
// Cloudflare Pages 에는 예약 실행이 없으므로 자주 쓰이는 요청에서 가끔(확률) 실행한다. 실패해도 요청에는 영향 없음.
import { makeSb } from './common.js';

const DAY = 86400000;
const iso = ms => new Date(Date.now() - ms).toISOString();

export async function housekeeping(env, chance = 0.02) {
  if (Math.random() >= chance) return false;
  const sb = makeSb(env);
  const del = q => sb(q, { method: 'DELETE' }).catch(() => null);
  try {
    const d30 = encodeURIComponent(iso(30 * DAY)), y1 = encodeURIComponent(iso(365 * DAY));
    await Promise.all([
      del(`/rest/v1/posts?status=eq.deleted&updated_at=lt.${d30}`),
      del(`/rest/v1/comments?status=eq.deleted&updated_at=lt.${d30}`),
      del(`/rest/v1/reports?status=in.(resolved,dismissed)&resolved_at=lt.${y1}`),
      del(`/rest/v1/sanctions?revoked_at=lt.${y1}`),
      del(`/rest/v1/sanctions?revoked_at=is.null&ends_at=lt.${y1}`),
      del(`/rest/v1/sanctions?kind=eq.warning&created_at=lt.${y1}`),
    ]);
  } catch (_) { /* 다음 기회에 다시 */ }
  return true;
}
