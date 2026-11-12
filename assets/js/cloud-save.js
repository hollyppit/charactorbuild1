// 계정 작업 저장 클라이언트 (window.CloudSave). auth-client.js(BoldAuth) 다음에 불러온다.
// 원칙: 브라우저(로컬) 저장이 먼저이고 이 모듈은 서버 동기화만 맡는다. 서버 저장이 확인되기 전에는 로컬 데이터를 지우지 않는다.
(function () {
  const STATUS_TEXT = {
    idle: '', saving: '저장 중...', saved: '저장됨 ✓', offline: '오프라인 · 연결되면 다시 저장해요',
    error: '저장 실패 · 다시 시도해 주세요', conflict: '다른 기기에서 먼저 저장했어요',
  };

  async function sha256hex(blob) {
    const buf = await blob.arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const api = {
    STATUS_TEXT,
    list(opts) {
      opts = opts || {};
      const q = new URLSearchParams();
      if (opts.kind) q.set('kind', opts.kind);
      if (opts.trashed) q.set('trashed', '1');
      return BoldAuth.api('/api/projects' + (q.toString() ? '?' + q : ''));
    },
    open(id) { return BoldAuth.api('/api/projects?id=' + encodeURIComponent(id)); },
    create(kind, title, data, childId) {
      return BoldAuth.api('/api/projects', { method: 'POST', body: JSON.stringify({ kind, title, data: data || {}, child_id: childId || undefined }) });
    },
    legacy(action, body) {
      return BoldAuth.api('/api/legacy?action=' + action, { method: 'POST', body: JSON.stringify(body) });
    },
    save(id, expectedVersion, data, extra) {
      extra = extra || {};
      const body = { expected_version: expectedVersion, data };
      if ('title' in extra) body.title = extra.title;
      if (extra.thumbAsset) body.thumb_asset = extra.thumbAsset;
      return BoldAuth.api('/api/projects?id=' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(body) });
    },
    trash(id) { return BoldAuth.api('/api/projects?id=' + encodeURIComponent(id), { method: 'DELETE' }); },
    restore(id) { return BoldAuth.api('/api/projects?action=restore&id=' + encodeURIComponent(id), { method: 'POST', body: '{}' }); },
    purge(id) { return BoldAuth.api('/api/projects?purge=1&id=' + encodeURIComponent(id), { method: 'DELETE' }); },

    // 이미지·음성 업로드: 같은 파일(해시)은 다시 올리지 않고 asset_id 만 돌려준다
    async uploadAsset(projectId, blob) {
      const sha = await sha256hex(blob);
      const ticket = await BoldAuth.api('/api/assets', {
        method: 'POST', body: JSON.stringify({ project_id: projectId, sha256: sha, mime: blob.type, bytes: blob.size }),
      });
      if (ticket.exists) return ticket.asset_id;
      const c = await BoldAuth.client();
      const up = await c.storage.from(ticket.bucket).uploadToSignedUrl(ticket.path, ticket.token, blob, { contentType: blob.type });
      if (up.error) throw up.error;
      await BoldAuth.api('/api/assets?action=confirm', { method: 'POST', body: JSON.stringify({ asset_id: ticket.asset_id }) });
      return ticket.asset_id;
    },

    /**
     * 자동 저장 동기화기. 도구(직접 그리기 등)는 상태를 가져오는 함수만 넘기면 된다.
     * opts: { projectId, version, getState(): object, onStatus(status,text), onConflict(info), debounceMs }
     * 반환: { touch(), flush(), stop(), get version }
     */
    syncer(opts) {
      let version = opts.version;
      let timer = null, running = false, pending = false, stopped = false;
      const debounce = opts.debounceMs || 2000;
      const minInterval = opts.minIntervalMs || 0;   // 자동 저장 사이 최소 간격 (이미지 저장이 잦아 용량을 낭비하지 않게)
      let lastRunAt = 0;
      const status = s => { if (opts.onStatus) opts.onStatus(s, STATUS_TEXT[s] || ''); };

      async function run() {
        if (stopped) return;
        if (running) { pending = true; return; }
        running = true; status('saving'); lastRunAt = Date.now();
        try {
          if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });
          // getState 는 동기/비동기 모두 가능. {data, thumbAsset?} 또는 data 객체를 돌려준다
          const st = await opts.getState();
          const payload = st && st.data ? st : { data: st };
          const r = await api.save(opts.projectId, version, payload.data, { thumbAsset: payload.thumbAsset });
          version = r.version; status('saved');
        } catch (e) {
          if (e.status === 409) { status('conflict'); if (opts.onConflict) opts.onConflict(e); }
          else if (e.offline || (e.name === 'TypeError')) { status('offline'); retryLater(); }
          else { status('error'); retryLater(); }
        } finally {
          running = false;
          if (pending && !stopped) { pending = false; schedule(); }
        }
      }
      function schedule() {
        clearTimeout(timer);
        const wait = Math.max(debounce, minInterval - (Date.now() - lastRunAt));
        timer = setTimeout(run, wait);
      }
      function retryLater() { clearTimeout(timer); timer = setTimeout(run, 15000); }

      window.addEventListener('online', schedule);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer) { clearTimeout(timer); run(); } });

      return {
        touch: schedule,
        flush: () => { clearTimeout(timer); return run(); },
        stop: () => { stopped = true; clearTimeout(timer); },
        get version() { return version; },
        setVersion(v) { version = v; },
      };
    },
  };
  window.CloudSave = api;
})();
