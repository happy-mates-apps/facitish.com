/* Gær runtime for TAS: answers the simulator's `window.claude.use(...)` calls with /api/tas, so app.js runs as it
   did on claude.ai. Loaded after env.js (window.TAS_ENV: who is signed in, may they edit, is AI on) and before
   the simulator's own scripts.

   db      collections and documents (Firestore-like: collection().where().orderBy().limit().onSnapshot(),
           doc().get()/set()/update()/delete()/onSnapshot()). Reads: everyone sees the published collections,
           editors also the drafts. Changes are polled every 15 s (and when the tab is shown again); a write is
           applied locally at once, like Firestore's latency compensation.
   user    the signed-in Gær user (null for anonymous visitors on /w).
   sample  json(prompt) through Gær's AI (null when AI is off or nobody is signed in).
   assets  image upload for editors; images are served from /api/tas/assets/<id>. */
(function () {
  'use strict';
  const ENV = window.TAS_ENV || { mode: 'public', signedIn: false, canEdit: false, ai: false };
  const POLL_MS = 15000;
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

  function codeFor(status) {
    if (status === 400 || status === 413 || status === 422) return 'invalid_argument';
    if (status === 401 || status === 403) return 'permission_denied';
    if (status === 404) return 'not_found';
    if (status === 429) return 'resource_exhausted';
    if (status === 507) return 'quota_exceeded';
    return 'unavailable';
  }
  async function api(method, path, body) {
    const form = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = { 'X-Gaer': '1' };
    if (body != null && !form) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch('/api/tas' + path, { method, credentials: 'same-origin', headers, body: body == null ? undefined : form ? body : JSON.stringify(body) });
    } catch (e) { throw { code: 'unavailable', message: String(e) }; }
    if (!r.ok) {
      let d = {}; try { d = await r.json(); } catch (e) {}
      throw { code: (d && d.code) || codeFor(r.status), status: r.status, message: d && d.detail };
    }
    return r.status === 204 ? null : r.json();
  }
  const enc = s => encodeURIComponent(s);

  /* ---------------- db ---------------- */
  const cols = {};      // col -> { docs: {id: data} | null (not loaded), forbidden, rev, loading }
  const docs = {};      // "col/id" -> { data | null, rev, loading } for documents read on their own
  const colSubs = [];   // { col, q, cb, err }
  const docSubs = [];   // { col, id, cb }
  const C = col => cols[col] || (cols[col] = { docs: null, forbidden: false, rev: null, loading: null });

  function snapDoc(id, data) {
    return { id, exists: data != null, data: () => clone(data), get: k => (data == null ? undefined : clone(data[k])) };
  }
  function valueAt(o, path) { return String(path).split('.').reduce((v, k) => (v == null ? undefined : v[k]), o); }
  function runQuery(all, q) {
    let list = Object.keys(all).map(id => ({ id, data: all[id] }));
    q.where.forEach(([f, op, v]) => {
      list = list.filter(d => {
        const x = valueAt(d.data, f);
        if (op === '==') return x === v;
        if (op === '!=') return x !== v;
        if (op === 'array-contains') return Array.isArray(x) && x.indexOf(v) >= 0;
        if (op === 'in') return Array.isArray(v) && v.indexOf(x) >= 0;
        if (op === '<') return x < v; if (op === '<=') return x <= v;
        if (op === '>') return x > v; if (op === '>=') return x >= v;
        return true;
      });
    });
    if (q.order) {
      const [f, dir] = q.order, s = dir === 'desc' ? -1 : 1;
      list.sort((a, b) => { const x = valueAt(a.data, f), y = valueAt(b.data, f); return x === y ? 0 : (x > y ? s : -s); });
    }
    if (q.limit != null) list = list.slice(0, q.limit);
    const out = list.map(d => snapDoc(d.id, d.data));
    return { docs: out, size: out.length, empty: !out.length, forEach: fn => out.forEach(fn) };
  }
  function emitCol(col) {
    const c = C(col);
    if (!c.docs) return;
    colSubs.filter(s => s.col === col).forEach(s => { try { s.cb(runQuery(c.docs, s.q)); } catch (e) { console.error(e); } });
    docSubs.filter(s => s.col === col).forEach(s => { try { s.cb(snapDoc(s.id, c.docs[s.id])); } catch (e) { console.error(e); } });
  }
  function emitDoc(col, id) {
    const c = C(col);
    const data = c.docs ? c.docs[id] : (docs[col + '/' + id] || {}).data;
    docSubs.filter(s => s.col === col && s.id === id).forEach(s => { try { s.cb(snapDoc(id, data)); } catch (e) { console.error(e); } });
    if (c.docs) colSubs.filter(s => s.col === col).forEach(s => { try { s.cb(runQuery(c.docs, s.q)); } catch (e) { console.error(e); } });
  }
  // Collections this viewer may not read (drafts, for anyone but editors) are empty without asking the server.
  const mayRead = col => !Array.isArray(ENV.collections) || ENV.collections.indexOf(col) >= 0;
  async function loadCol(col) {
    const c = C(col);
    if (!mayRead(col)) { c.docs = c.docs || {}; c.forbidden = true; return; }
    if (c.loading) return c.loading;
    c.loading = api('GET', '/docs/' + enc(col)).then(r => {
      c.docs = {}; (r.docs || []).forEach(d => { c.docs[d.id] = d.data; }); c.rev = r.rev; c.forbidden = false;
    }).catch(e => {
      // Drafts are for editors: everyone else simply sees an empty collection, as on claude.ai.
      if (e && e.code === 'permission_denied') { c.docs = {}; c.forbidden = true; return; }
      throw e;
    }).finally(() => { c.loading = null; });
    return c.loading;
  }
  async function loadDoc(col, id) {
    const key = col + '/' + id;
    const d = docs[key] || (docs[key] = { data: null, loading: null });
    if (!mayRead(col)) return;
    if (d.loading) return d.loading;
    d.loading = api('GET', '/docs/' + enc(col) + '/' + enc(id)).then(r => { d.data = r.data; }).catch(e => {
      if (e && (e.code === 'not_found' || e.code === 'permission_denied')) { d.data = null; return; }
      throw e;
    }).finally(() => { d.loading = null; });
    return d.loading;
  }

  class Query {
    constructor(col, q) { this.col = col; this.q = q || { where: [], order: null, limit: null }; }
    where(f, op, v) { return new Query(this.col, Object.assign({}, this.q, { where: this.q.where.concat([[f, op, v]]) })); }
    orderBy(f, dir) { return new Query(this.col, Object.assign({}, this.q, { order: [f, dir || 'asc'] })); }
    limit(n) { return new Query(this.col, Object.assign({}, this.q, { limit: n })); }
    async get() { await loadCol(this.col); return runQuery(C(this.col).docs, this.q); }
    onSnapshot(cb, err) {
      const sub = { col: this.col, q: this.q, cb };
      colSubs.push(sub);
      const c = C(this.col);
      if (c.docs) setTimeout(() => { if (colSubs.indexOf(sub) >= 0) cb(runQuery(c.docs, sub.q)); }, 0);
      else loadCol(this.col).then(() => { if (colSubs.indexOf(sub) >= 0) cb(runQuery(C(this.col).docs, sub.q)); }).catch(e => err && err(e));
      return () => { const i = colSubs.indexOf(sub); if (i >= 0) colSubs.splice(i, 1); };
    }
    doc(id) { return new DocRef(this.col, id); }
  }
  function known(col, id) {
    const c = C(col);
    if (c.docs) return c.docs[id];
    const d = docs[col + '/' + id];
    return d ? d.data : undefined;
  }
  function remember(col, id, data) {
    const c = C(col);
    if (c.docs) { if (data == null) delete c.docs[id]; else c.docs[id] = data; }
    const key = col + '/' + id;
    (docs[key] || (docs[key] = { data: null, loading: null })).data = data;
    emitDoc(col, id);
  }
  class DocRef {
    constructor(col, id) { this.col = col; this.id = id; this.path = col + '/' + id; }
    async get() {
      if (C(this.col).docs) return snapDoc(this.id, C(this.col).docs[this.id]);
      await loadDoc(this.col, this.id);
      return snapDoc(this.id, docs[this.path].data);
    }
    onSnapshot(cb, err) {
      const sub = { col: this.col, id: this.id, cb };
      docSubs.push(sub);
      const fire = () => { if (docSubs.indexOf(sub) >= 0) cb(snapDoc(this.id, known(this.col, this.id))); };
      if (known(this.col, this.id) !== undefined) setTimeout(fire, 0);
      else loadDoc(this.col, this.id).then(fire).catch(e => err && err(e));
      return () => { const i = docSubs.indexOf(sub); if (i >= 0) docSubs.splice(i, 1); };
    }
    async set(data) { const r = await api('PUT', '/docs/' + enc(this.col) + '/' + enc(this.id), { data }); remember(this.col, this.id, r.data); }
    async update(data) { const r = await api('PATCH', '/docs/' + enc(this.col) + '/' + enc(this.id), { data }); remember(this.col, this.id, r.data); }
    async delete() { await api('DELETE', '/docs/' + enc(this.col) + '/' + enc(this.id)); remember(this.col, this.id, null); }
  }
  const db = {
    collection: col => new Query(col),
    doc: path => { const i = String(path).indexOf('/'); return new DocRef(path.slice(0, i), path.slice(i + 1)); }
  };

  // Changes by other editors: one small request tells which collections changed, only those are read again.
  let polling = false;
  async function poll() {
    if (polling || document.hidden) return;
    const watched = new Set(colSubs.map(s => s.col).concat(docSubs.map(s => s.col)));
    if (!watched.size) return;
    polling = true;
    try {
      const revs = (await api('GET', '/rev')).revs || {};
      for (const col of watched) {
        const c = C(col);
        if (c.forbidden || revs[col] === undefined || revs[col] === c.rev) continue;
        if (c.docs) { await loadCol(col); emitCol(col); continue; }
        c.rev = revs[col];
        for (const s of docSubs.filter(x => x.col === col)) { await loadDoc(col, s.id); emitDoc(col, s.id); }
      }
    } catch (e) { /* offline for a moment: the next round tries again */ } finally { polling = false; }
  }
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  /* ---------------- user, sample, assets ---------------- */
  const user = ENV.signedIn ? {
    canEdit: async () => !!ENV.canEdit,
    isOwner: async () => false,
    id: async () => ENV.uid,
    profiles: ids => api('POST', '/profiles', { ids }).then(r => r.profiles || {})
  } : null;
  const sample = ENV.ai ? {
    json: async (prompt) => {
      try { return (await api('POST', '/ai', { prompt: String(prompt) })).result; }
      catch (e) { if (e && (e.status === 403 || e.status === 404)) e.code = 'sampling_disabled'; throw e; }
    }
  } : null;
  const assets = ENV.canEdit ? {
    upload: async (file) => { const f = new FormData(); f.append('file', file); return api('POST', '/assets', f); },
    url: id => '/api/tas/assets/' + enc(id)
  } : null;
  const caps = { db, user, sample, assets };
  window.claude = { use: name => Promise.resolve(Object.prototype.hasOwnProperty.call(caps, name) ? caps[name] : null) };

  /* ---------------- Gær around TAS ---------------- */
  const top = ENV.mode === 'backoffice' ? ' target="_top"' : '';
  const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  ENV.lockHtml = function () {
    let title = 'Admin Portal', text, link = '', label = '';
    if (!ENV.signedIn) { text = 'Log in to edit menus and knowledge.'; link = '/login?next=/backoffice'; label = 'Log in'; }
    else if (ENV.needsMfa) { text = 'Editing needs a second factor. Confirm with your passkey, security key or authenticator app in the admin area, then come back.'; link = '/admin'; label = 'Confirm in admin'; }
    else { text = 'Your account can use the simulator but not edit it. Ask an administrator for the admin role “Indhold”.'; }
    return '<div class="lock"><div class="lock-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>' +
      '<h1>' + title + '</h1><p>' + escH(text) + '</p>' + (link ? '<a class="btn primary" href="' + link + '"' + top + '>' + label + '</a>' : '') + '</div>';
  };
  function decorate() {
    const a = document.getElementById('gaerLink');
    if (!a) return;
    if (ENV.mode === 'backoffice') { a.hidden = true; return; }
    a.href = ENV.signedIn ? '/backoffice' : '/login?next=/backoffice';
    a.textContent = ENV.signedIn ? (ENV.canEdit ? 'Admin Portal' : 'Backoffice') : 'Log in';
    a.hidden = false;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate); else decorate();
})();
