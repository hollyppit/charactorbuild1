// 비공개 버킷(user-assets, post-media) 서버 전용 헬퍼. service_role 키로 서명 주소 발급·삭제를 수행한다.
// 마지막 인자 bucket 을 생략하면 user-assets(작업 파일)를 쓴다.
import { supabaseKey } from './common.js';

export const BUCKET = 'user-assets';
export const POST_BUCKET = 'post-media';

function headers(env) {
  const key = supabaseKey(env);
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// 여러 파일의 읽기용 서명 주소(기본 1시간). 반환: { [path]: signedUrl }
export async function signDownloads(env, paths, expiresIn = 3600, bucket = BUCKET) {
  const out = {};
  if (!paths.length) return out;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${bucket}`, {
    method: 'POST', headers: headers(env), body: JSON.stringify({ expiresIn, paths }),
  });
  if (!r.ok) return out;
  const rows = await r.json();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.signedURL && !row.error) out[row.path] = `${env.SUPABASE_URL}/storage/v1${row.signedURL}`;
  }
  return out;
}

// 업로드용 서명 토큰. 반환: { token } 또는 null
export async function signUpload(env, path, bucket = BUCKET) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/upload/sign/${bucket}/${path}`, {
    method: 'POST', headers: headers(env), body: '{}',
  });
  if (!r.ok) return null;
  const j = await r.json();
  const token = j.token || (j.url ? new URL(j.url, env.SUPABASE_URL).searchParams.get('token') : null);
  return token ? { token } : null;
}

// 파일 정보(크기 확인용). 없으면 null
export async function objectInfo(env, path, bucket = BUCKET) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/info/${bucket}/${path}`, { headers: headers(env) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

export async function removeObjects(env, paths, bucket = BUCKET) {
  if (!paths.length) return true;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE', headers: headers(env), body: JSON.stringify({ prefixes: paths }),
  });
  return r.ok;
}
