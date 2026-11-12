// 비공개 버킷(user-assets) 서버 전용 헬퍼. service_role 키로 서명 주소 발급·삭제를 수행한다.
import { supabaseKey } from './common.js';

export const BUCKET = 'user-assets';

function headers(env) {
  const key = supabaseKey(env);
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// 여러 파일의 읽기용 서명 주소(기본 1시간). 반환: { [path]: signedUrl }
export async function signDownloads(env, paths, expiresIn = 3600) {
  const out = {};
  if (!paths.length) return out;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
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
export async function signUpload(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${path}`, {
    method: 'POST', headers: headers(env), body: '{}',
  });
  if (!r.ok) return null;
  const j = await r.json();
  const token = j.token || (j.url ? new URL(j.url, env.SUPABASE_URL).searchParams.get('token') : null);
  return token ? { token } : null;
}

// 파일 정보(크기 확인용). 없으면 null
export async function objectInfo(env, path) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/info/${BUCKET}/${path}`, { headers: headers(env) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

export async function removeObjects(env, paths) {
  if (!paths.length) return true;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE', headers: headers(env), body: JSON.stringify({ prefixes: paths }),
  });
  return r.ok;
}
