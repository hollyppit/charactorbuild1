// 보관 기간이 지난 소셜·그룹 기록 정리 (라우트 아님). 개인정보 처리방침 4조와 맞춘다.
//  - 삭제한 게시물 기록: 삭제 후 30일 (그림 파일은 삭제할 때 이미 지움)
//  - 지운 댓글 내용: 지운 뒤 30일
//  - 처리 끝난 신고: 처리 후 1년
//  - 끝나거나 해제된 이용 제한(경고 포함): 1년
//  - 지운 그룹 작품·지운 그룹: 30일 뒤 그림 파일·용량과 함께 파기 (장면·버전·기여 기록은 함께 지워짐)
//  - 답이 끝난 그룹 초대: 90일
//  - 게임 방(5단계, 0016): 시작 안 한 방 2시간·6시간 넘은 진행 방은 닫고, 끝난 방과 결과는 90일 뒤 삭제 (gm_housekeeping, 0016 전에는 조용히 실패)
//  (알림 90일·AI 이용 기록 90일은 DB 함수가 따로 정리)
// Cloudflare Pages 에는 예약 실행이 없으므로 자주 쓰이는 요청에서 가끔(확률) 실행한다. 실패해도 요청에는 영향 없음.
import { makeSb } from './common.js';
import { removeObjects, BUCKET } from './storage.js';

const DAY = 86400000;
const iso = ms => new Date(Date.now() - ms).toISOString();

// 그룹 작품 여러 개를 파일·용량까지 완전히 지움
export async function purgeGroupStories(env, storyIds) {
  if (!storyIds.length) return 0;
  const sb = makeSb(env);
  const ar = await sb(`/rest/v1/group_story_assets?story_id=in.(${storyIds.join(',')})&select=path,bytes,uploader_id`);
  const assets = ar.ok ? await ar.json() : [];
  for (let i = 0; i < assets.length; i += 100) await removeObjects(env, assets.slice(i, i + 100).map(a => a.path), BUCKET);
  const per = {};
  assets.forEach(a => { per[a.uploader_id] = (per[a.uploader_id] || 0) + Number(a.bytes || 0); });
  for (const [owner, bytes] of Object.entries(per)) {
    if (bytes > 0) await sb('/rest/v1/rpc/release_quota', { method: 'POST', body: JSON.stringify({ p_owner: owner, p_bytes: bytes }) });
  }
  await sb(`/rest/v1/group_stories?id=in.(${storyIds.join(',')})`, { method: 'DELETE' });   // 장면·버전·기록·파일 기록은 CASCADE
  return storyIds.length;
}

async function purgeGroups(env, d30) {
  const sb = makeSb(env);
  const [sr, gr] = await Promise.all([
    sb(`/rest/v1/group_stories?deleted_at=lt.${d30}&select=id&limit=20`),
    sb(`/rest/v1/groups?deleted_at=lt.${d30}&select=id&limit=20`),
  ]);
  const stories = sr.ok ? (await sr.json()).map(x => x.id) : [];
  const groups = gr.ok ? (await gr.json()).map(x => x.id) : [];
  if (groups.length) {
    const gs = await sb(`/rest/v1/group_stories?group_id=in.(${groups.join(',')})&select=id`);
    (gs.ok ? await gs.json() : []).forEach(x => { if (!stories.includes(x.id)) stories.push(x.id); });
  }
  await purgeGroupStories(env, stories);
  if (groups.length) await sb(`/rest/v1/groups?id=in.(${groups.join(',')})`, { method: 'DELETE' });   // 그룹원·초대는 CASCADE
}

export async function housekeeping(env, chance = 0.02) {
  if (Math.random() >= chance) return false;
  const sb = makeSb(env);
  const del = q => sb(q, { method: 'DELETE' }).catch(() => null);
  try {
    const d30 = encodeURIComponent(iso(30 * DAY)), d90 = encodeURIComponent(iso(90 * DAY)), y1 = encodeURIComponent(iso(365 * DAY));
    await Promise.all([
      del(`/rest/v1/posts?status=eq.deleted&updated_at=lt.${d30}`),
      del(`/rest/v1/comments?status=eq.deleted&updated_at=lt.${d30}`),
      del(`/rest/v1/reports?status=in.(resolved,dismissed)&resolved_at=lt.${y1}`),
      del(`/rest/v1/sanctions?revoked_at=lt.${y1}`),
      del(`/rest/v1/sanctions?revoked_at=is.null&ends_at=lt.${y1}`),
      del(`/rest/v1/sanctions?kind=eq.warning&created_at=lt.${y1}`),
      del(`/rest/v1/group_invites?status=neq.pending&responded_at=lt.${d90}`),
      purgeGroups(env, d30).catch(() => null),
      sb('/rest/v1/rpc/gm_housekeeping', { method: 'POST', body: '{}' }).catch(() => null),
    ]);
  } catch (_) { /* 다음 기회에 다시 */ }
  return true;
}
