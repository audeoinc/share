// ウェブビューの中で、fetch と WebSocket を、拡張ホストへの postMessage に置き換える (画面 app.js は、単体版と同じもの)。
(() => {
  const vs = acquireVsCodeApi(); const pend = new Map(); const socks = new Map(); let seq = 0;
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => { const b = atob(s || ''); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  window.addEventListener('message', (e) => {
    const m = e.data; if (!m || !m.t) return;
    if (m.t === 'cwd' || m.t === 'git') { const go = (n) => { const f = m.t === 'cwd' ? window.crogueSetCwd : window.crogueGitRefresh; if (f) f(m.path); else if (n < 50) setTimeout(() => go(n + 1), 200); }; go(0); return; }
    if (m.t === 'attach') { const go = (n) => { if (window.crogueAttach) window.crogueAttach(m.items); else if (n < 50) setTimeout(() => go(n + 1), 200); }; go(0); return; }
    if (m.t === 'fetch-res') {
      const p = pend.get(m.id); pend.delete(m.id); if (!p) return;
      if (!m.status) return p.reject(new TypeError(m.error || 'fetch failed'));
      p.resolve(new Response(unb64(m.body), { status: m.status, headers: { 'Content-Type': m.ctype || 'application/octet-stream' } }));
    } else {
      const w = socks.get(m.id); if (!w) return;
      if (m.t === 'ws-open') { w.readyState = 1; if (w.onopen) w.onopen({}); }
      else if (m.t === 'ws-msg') { if (w.onmessage) w.onmessage({ data: m.data }); }
      else if (m.t === 'ws-close') { w.readyState = 3; socks.delete(m.id); if (w.onclose) w.onclose({}); }
    }
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url.url;
    if (!u.startsWith('/') && !u.startsWith('api/') && !u.startsWith(location.origin)) return realFetch(url, init);
    const id = ++seq; let body = null; const b = init.body;
    if (b != null) body = typeof b === 'string' ? btoa(unescape(encodeURIComponent(b))) : b instanceof Blob ? b64(await b.arrayBuffer()) : b64(b.buffer ? b.buffer : b);
    const headers = {}; new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    return new Promise((resolve, reject) => { pend.set(id, { resolve, reject }); vs.postMessage({ t: 'fetch', id, url: u.replace(location.origin, ''), method: init.method || 'GET', headers, body }); });
  };
  window.WebSocket = class {
    constructor() { this.id = ++seq; this.readyState = 0; socks.set(this.id, this); vs.postMessage({ t: 'ws-open', id: this.id }); }
    send(d) { vs.postMessage({ t: 'ws-send', id: this.id, data: String(d) }); }
    close() { vs.postMessage({ t: 'ws-close', id: this.id }); }
  };
  // VS Code のエクスプローラーから落とされたファイル・フォルダ (Shift を押しながらドラッグ) を、元の場所のまま添付する
  const URI_TYPES = ['resourceurls', 'application/vnd.code.uri-list', 'text/uri-list', 'codeeditors'];
  const hasUri = (e) => e.dataTransfer && URI_TYPES.some((t) => [...e.dataTransfer.types].includes(t));
  window.addEventListener('dragover', (e) => { if (hasUri(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }, true);
  window.addEventListener('drop', (e) => {
    if (!hasUri(e)) return;
    const uris = [];
    try { const r = e.dataTransfer.getData('resourceurls'); if (r) for (const u of JSON.parse(r)) uris.push(u); } catch { /* 無視 */ }
    if (!uris.length) for (const t of ['application/vnd.code.uri-list', 'text/uri-list']) { const v = e.dataTransfer.getData(t); if (v) { for (const l of v.split(/\r?\n/)) if (l && l[0] !== '#') uris.push(l.trim()); break; } }
    if (!uris.length) return;
    e.preventDefault(); e.stopPropagation(); vs.postMessage({ t: 'drop-uris', uris });
  }, true);
  // <img> / <iframe> / <embed> / <video> の src が、サーバーの相対パス (/api/raw など) のとき: 中継で取得して、blob の URL にする (右のプレビューの、画像・PDF 用)
  const toBlobSrc = async (node, url) => {
    try { const r = await window.fetch(url); if (!r.ok) throw new Error(String(r.status)); node.setAttribute('data-src-orig', url); Element.prototype.setAttribute.call(node, 'src', URL.createObjectURL(await r.blob())); }
    catch { /* 取得できないときは、何もしない */ }
  };
  for (const C of [HTMLImageElement, HTMLIFrameElement, HTMLEmbedElement, HTMLVideoElement, HTMLAudioElement]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, 'src'); if (!d || !d.set) continue;
    Object.defineProperty(C.prototype, 'src', { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { if (typeof v === 'string' && v.startsWith('/api/')) toBlobSrc(this, v); else d.set.call(this, v); } });
  }
  const origSet = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (k, v) { if (k === 'src' && typeof v === 'string' && v.startsWith('/api/') && /^(IMG|IFRAME|EMBED|VIDEO|AUDIO)$/.test(this.tagName)) { toBlobSrc(this, v); return; } return origSet.call(this, k, v); };
  window.__crogueHost = 'vscode';
  if (window.__crogueCwd) window.dispatchEvent(new MessageEvent('message', { data: { t: 'cwd', path: window.__crogueCwd } })); // 作業フォルダは、VS Code のフォルダに合わせる
})();
