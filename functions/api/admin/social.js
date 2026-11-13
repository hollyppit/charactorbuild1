// 관리자: 게시물 검토·신고 처리·제재·설정 (X-Admin-Hash 필요. 공개 스위치와 관계없이 동작)
//  GET  /api/admin/social?view=pending|hidden|published|reports|settings
//  GET  /api/admin/social?view=user&id=uuid   (또는 &n=닉네임)
//  POST /api/admin/social  {action, ...}
//    approve {post_id} / reject {post_id, reason} / hide {post_id, reason} / restore {post_id} / remove {post_id, reason}
//    hide_comment {comment_id, reason} / restore_comment {comment_id} / remove_comment {comment_id, reason}
//    resolve_report {report_id, resolution} / dismiss_report {report_id, resolution?}
//    sanction {user_id, kind:'warning'|'post_ban'|'suspend', reason, days?(비우면 기한 없음), report_id?}
//    revoke_sanction {sanction_id}
//    settings {require_approval, auto_hide_reports, daily_post_limit, daily_report_limit}
import { corsHeaders, jsonResponder, checkOrigin, checkSize, isAdmin, makeSb } from '../_lib/common.js';
import { removeObjects, signDownloads, POST_BUCKET } from '../_lib/storage.js';
import { rpc, attachCovers, POST_COLS, UUID, notify } from '../_lib/social.js';
import { housekeeping } from '../_lib/housekeeping.js';

const now = () => new Date().toISOString();
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export async function onRequest({ request, env }) {
  const cors = corsHeaders(request, env, 'GET,POST,OPTIONS');
  const json = jsonResponder(cors);
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const bad = checkOrigin(request, env, cors) || checkSize(request, 16 * 1024, cors);
  if (bad) return bad;
  if (!isAdmin(request, env)) return json({ error: 'admin_required' }, 403);
  if (!env.SUPABASE_SERVICE_KEY) return json({ error: 'not_configured' }, 503);
  const sb = makeSb(env);
  const url = new URL(request.url);

  const getPost = async id => {
    if (!UUID.test(String(id || ''))) return null;
    const r = await sb(`/rest/v1/posts?id=eq.${id}&select=id,owner_id,status,status_reason`);
    return (r.ok ? await r.json() : [])[0] || null;
  };
  const patchPost = (id, patch) => sb(`/rest/v1/posts?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: now(), reviewed_at: now() }) });
  const closeReports = (postId, status, resolution) => sb(`/rest/v1/reports?target_type=eq.post&target_id=eq.${postId}&status=eq.open`, {
    method: 'PATCH', body: JSON.stringify({ status, resolution: txt(resolution, 500) || null, resolved_at: now() }),
  });

  // ── 조회 ──
  if (request.method === 'GET') {
    await housekeeping(env, 0.3);   // 관리자 화면을 열 때 보관 기간 지난 기록 정리
    const view = url.searchParams.get('view') || 'pending';
    if (['pending', 'hidden', 'published', 'rejected'].includes(view)) {
      const order = view === 'published' ? 'published_at.desc' : 'updated_at.desc';
      const r = await sb(`/rest/v1/posts?status=eq.${view}&select=${POST_COLS}&order=${order}&limit=100`);
      if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
      const rows = r.ok ? await r.json() : [];
      return json({ posts: await attachCovers(env, rows) });
    }
    if (view === 'reports') {
      const r = await sb('/rest/v1/reports?status=eq.open&select=*,reporter:profiles!reports_reporter_id_fkey(nickname),owner:profiles!reports_target_owner_fkey(nickname)&order=created_at.desc&limit=200');
      if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
      const reports = r.ok ? await r.json() : [];
      const postIds = [...new Set(reports.filter(x => x.target_type === 'post').map(x => x.target_id))];
      let posts = {};
      if (postIds.length) {
        const pr = await sb(`/rest/v1/posts?id=in.(${postIds.join(',')})&select=${POST_COLS}`);
        const rows = await attachCovers(env, pr.ok ? await pr.json() : []);
        posts = Object.fromEntries(rows.map(p => [p.id, p]));
      }
      const commentIds = [...new Set(reports.filter(x => x.target_type === 'comment').map(x => x.target_id))];
      let comments = {};
      if (commentIds.length) {
        const cr = await sb(`/rest/v1/comments?id=in.(${commentIds.join(',')})&select=id,post_id,body,status,status_reason,report_count,created_at,author_id,author:profiles!comments_author_id_fkey(nickname),post:posts(title)`);
        comments = Object.fromEntries((cr.ok ? await cr.json() : []).map(c => [c.id, c]));
      }
      return json({ reports: reports.map(x => ({ ...x, post: posts[x.target_id] || null, comment: comments[x.target_id] || null })) });
    }
    if (view === 'user') {
      const id = url.searchParams.get('id'), n = url.searchParams.get('n');
      const q = UUID.test(String(id || '')) ? `id=eq.${id}` : n ? `nickname=eq.${encodeURIComponent(n)}` : null;
      if (!q) return json({ error: 'not_found' }, 404);
      const r = await sb(`/rest/v1/profiles?${q}&select=id,nickname,avatar_url,visibility,role,created_at`);
      const p = (r.ok ? await r.json() : [])[0];
      if (!p) return json({ error: 'not_found' }, 404);
      const [sr, pr, rr, cr, br] = await Promise.all([
        sb(`/rest/v1/sanctions?user_id=eq.${p.id}&select=*&order=created_at.desc&limit=50`),
        sb(`/rest/v1/posts?owner_id=eq.${p.id}&status=neq.deleted&select=${POST_COLS}&order=created_at.desc&limit=50`),
        sb(`/rest/v1/reports?target_owner=eq.${p.id}&select=id,target_type,reason,status,created_at&order=created_at.desc&limit=50`),
        sb(`/rest/v1/comments?author_id=eq.${p.id}&status=neq.deleted&select=id,post_id,body,status,report_count,created_at,post:posts(title)&order=created_at.desc&limit=50`),
        sb(`/rest/v1/blocks?blocked_id=eq.${p.id}&select=blocker_id&limit=1000`),
      ]);
      return json({
        profile: p, sanctions: sr.ok ? await sr.json() : [],
        posts: await attachCovers(env, pr.ok ? await pr.json() : []), reports: rr.ok ? await rr.json() : [],
        comments: cr.ok ? await cr.json() : [], blocked_by_count: br.ok ? (await br.json()).length : 0,
      });
    }
    if (view === 'post') {
      const id = url.searchParams.get('id');
      if (!UUID.test(String(id || ''))) return json({ error: 'not_found' }, 404);
      const mr = await sb(`/rest/v1/post_media?post_id=eq.${id}&select=idx,path,mime,body,audio_path&order=idx.asc`);
      const rows = mr.ok ? await mr.json() : [];
      const urls = await signDownloads(env, [...rows.map(x => x.path), ...rows.filter(x => x.audio_path).map(x => x.audio_path)], 3600, POST_BUCKET);
      return json({ media: rows.map(x => ({ idx: x.idx, url: urls[x.path] || null, type: String(x.mime || '').startsWith('video/') ? 'video' : 'image', body: x.body || '', audio_url: x.audio_path ? urls[x.audio_path] || null : null })) });
    }
    if (view === 'settings') {
      const r = await sb('/rest/v1/social_settings?id=eq.1&select=*');
      if (r.status === 404 || r.status === 400) return json({ error: 'social_not_ready' }, 503);
      return json({ settings: (r.ok ? await r.json() : [])[0] || null, mode: String(env.SOCIAL_ENABLED || 'off') });
    }
    return json({ error: 'bad_request' }, 400);
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const a = String(b.action || '');

  if (['approve', 'reject', 'hide', 'restore', 'remove'].includes(a)) {
    const p = await getPost(b.post_id);
    if (!p || p.status === 'deleted') return json({ error: 'not_found' }, 404);
    const reason = txt(b.reason, 500);
    if ((a === 'reject' || a === 'hide' || a === 'remove') && !reason) return json({ error: '사유를 적어 주세요 (게시자에게 보여요).' }, 400);
    if (a === 'approve' || a === 'restore') {
      if (!['pending', 'hidden', 'rejected'].includes(p.status)) return json({ error: '지금 상태에서는 할 수 없어요.' }, 409);
      await patchPost(p.id, { status: 'published', status_reason: null, published_at: now(), report_count: 0 });
      if (a === 'restore') await closeReports(p.id, 'dismissed', reason || '검토 결과 문제없음');
    } else if (a === 'reject') {
      await patchPost(p.id, { status: 'rejected', status_reason: reason, published_at: null });
    } else if (a === 'hide') {
      await patchPost(p.id, { status: 'hidden', status_reason: reason });
      await closeReports(p.id, 'resolved', '가림 처리: ' + reason);
    } else if (a === 'remove') {
      await closeReports(p.id, 'resolved', '삭제 처리: ' + reason);
      const res = await rpc(env, 'social_delete_post', { p_post: p.id, p_owner: null, p_admin: true });
      if (res.data && res.data.ok) await removeObjects(env, res.data.paths || [], POST_BUCKET);
      await sb(`/rest/v1/posts?id=eq.${p.id}`, { method: 'PATCH', body: JSON.stringify({ status_reason: reason }) });
    }
    // 게시자에게 알림 (앱 안)
    const nt = { approve: 'post_approved', reject: 'post_rejected', hide: 'post_hidden', remove: 'post_removed' }[a];
    if (nt) await notify(env, p.owner_id, nt, { post_id: p.id, data: reason ? { reason } : null });
    return json({ ok: true });
  }

  // ── 댓글 관리 ──
  if (['hide_comment', 'restore_comment', 'remove_comment'].includes(a)) {
    if (!UUID.test(String(b.comment_id || ''))) return json({ error: 'not_found' }, 404);
    const cr = await sb(`/rest/v1/comments?id=eq.${b.comment_id}&select=id,post_id,author_id,status`);
    const c = (cr.ok ? await cr.json() : [])[0];
    if (!c || c.status === 'deleted') return json({ error: 'not_found' }, 404);
    const reason = txt(b.reason, 500);
    if (a !== 'restore_comment' && !reason) return json({ error: '사유를 적어 주세요 (댓글 쓴 사람에게 보여요).' }, 400);
    const closeC = (status, resolution) => sb(`/rest/v1/reports?target_type=eq.comment&target_id=eq.${c.id}&status=eq.open`, {
      method: 'PATCH', body: JSON.stringify({ status, resolution, resolved_at: now() }) });
    if (a === 'restore_comment') {
      await sb(`/rest/v1/comments?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'visible', status_reason: null, report_count: 0, updated_at: now() }) });
      await closeC('dismissed', reason || '검토 결과 문제없음');
    } else if (a === 'hide_comment') {
      await sb(`/rest/v1/comments?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'hidden', status_reason: reason, updated_at: now() }) });
      await closeC('resolved', '가림 처리: ' + reason);
      await notify(env, c.author_id, 'comment_hidden', { post_id: c.post_id, data: { reason } });
    } else {
      await rpc(env, 'social_delete_comment', { p_actor: null, p_comment: c.id, p_admin: true });
      await sb(`/rest/v1/comments?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ status_reason: reason }) });
      await closeC('resolved', '삭제 처리: ' + reason);
      await notify(env, c.author_id, 'comment_hidden', { post_id: c.post_id, data: { reason, removed: true } });
    }
    // 게시물의 보이는 댓글 수 다시 세기
    const vr = await sb(`/rest/v1/comments?post_id=eq.${c.post_id}&status=eq.visible&select=id&limit=10000`);
    await sb(`/rest/v1/posts?id=eq.${c.post_id}`, { method: 'PATCH', body: JSON.stringify({ comment_count: (vr.ok ? await vr.json() : []).length }) });
    return json({ ok: true });
  }

  if (a === 'resolve_report' || a === 'dismiss_report') {
    if (!UUID.test(String(b.report_id || ''))) return json({ error: 'not_found' }, 404);
    const r = await sb(`/rest/v1/reports?id=eq.${b.report_id}&status=eq.open`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: a === 'resolve_report' ? 'resolved' : 'dismissed', resolution: txt(b.resolution, 500) || null, resolved_at: now() }),
    });
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return json({ error: 'not_found' }, 404);
    // 게시물 신고 수 다시 세기
    const rep = rows[0];
    if (rep.target_type === 'post' || rep.target_type === 'comment') {
      const cr = await sb(`/rest/v1/reports?target_type=eq.${rep.target_type}&target_id=eq.${rep.target_id}&status=eq.open&select=reporter_id`);
      const open = cr.ok ? await cr.json() : [];
      const tbl = rep.target_type === 'post' ? 'posts' : 'comments';
      await sb(`/rest/v1/${tbl}?id=eq.${rep.target_id}`, { method: 'PATCH', body: JSON.stringify({ report_count: new Set(open.map(x => x.reporter_id)).size }) });
    }
    return json({ ok: true });
  }

  if (a === 'sanction') {
    if (!UUID.test(String(b.user_id || ''))) return json({ error: 'not_found' }, 404);
    if (!['warning', 'post_ban', 'suspend'].includes(b.kind)) return json({ error: 'invalid_kind' }, 400);
    const reason = txt(b.reason, 500);
    if (!reason) return json({ error: '사유를 적어 주세요 (본인에게 보여요).' }, 400);
    const days = b.days == null || b.days === '' ? null : Number(b.days);
    if (days != null && !(Number.isInteger(days) && days >= 1 && days <= 3650)) return json({ error: '기간은 1~3650일로 적어 주세요.' }, 400);
    const row = { user_id: b.user_id, kind: b.kind, reason, ends_at: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
      report_id: UUID.test(String(b.report_id || '')) ? b.report_id : null };
    const r = await sb('/rest/v1/sanctions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!r.ok) return json({ error: 'sanction_failed' }, 500);
    if (b.kind === 'suspend') {
      await sb(`/rest/v1/posts?owner_id=eq.${b.user_id}&status=eq.published`, {
        method: 'PATCH', body: JSON.stringify({ status: 'hidden', status_reason: 'account_suspended', updated_at: now() }),
      });
    }
    await notify(env, b.user_id, 'sanction', { data: { kind: b.kind, reason, ends_at: row.ends_at } });
    return json({ ok: true, sanction: (await r.json())[0] });
  }

  if (a === 'revoke_sanction') {
    if (!UUID.test(String(b.sanction_id || ''))) return json({ error: 'not_found' }, 404);
    const r = await sb(`/rest/v1/sanctions?id=eq.${b.sanction_id}&revoked_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ revoked_at: now() }),
    });
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return json({ error: 'not_found' }, 404);
    const s = rows[0];
    if (s.kind === 'suspend') {
      const act = await rpc(env, 'social_active_sanction', { p_user: s.user_id });
      if (!(act.data && act.data.kind === 'suspend')) {
        await sb(`/rest/v1/posts?owner_id=eq.${s.user_id}&status=eq.hidden&status_reason=eq.account_suspended`, {
          method: 'PATCH', body: JSON.stringify({ status: 'published', status_reason: null, updated_at: now() }),
        });
      }
    }
    return json({ ok: true });
  }

  if (a === 'settings') {
    const s = b.settings || {};
    const int = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : null;
    const patch = {
      require_approval: !!s.require_approval,
      auto_hide_reports: int(s.auto_hide_reports, 1, 100),
      daily_post_limit: int(s.daily_post_limit, 0, 1000),
      daily_report_limit: int(s.daily_report_limit, 0, 1000),
      ...(s.hourly_comment_limit != null ? { hourly_comment_limit: int(s.hourly_comment_limit, 0, 1000) } : {}),
    };
    if (Object.values(patch).some(v => v === null)) return json({ error: '숫자를 확인해 주세요.' }, 400);
    const r = await sb('/rest/v1/social_settings?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: now() }) });
    return r.ok ? json({ ok: true, settings: (await r.json())[0] }) : json({ error: 'update_failed' }, 500);
  }

  return json({ error: 'unknown_action' }, 400);
}
