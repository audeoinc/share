// cdock web — フロントエンド (依存なし)
const $ = (s) => document.querySelector(s);
const chat = $('#chat'), input = $('#input'), sendBtn = $('#send'), stopBtn = $('#stop'), statusEl = $('#status');
const cwdEl = $('#cwd'), modeEl = $('#mode'), modelEl = $('#model');

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無視 */ } },
};
modeEl.value = store.get('mode', 'default');
modelEl.value = store.get('model', '');

// ---------- 最小 Markdown (すべて先にエスケープ) ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function md(src) {
  const out = []; const lines = src.replace(/\r\n/g, '\n').split('\n'); let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```(\w*)\s*$/.test(ln)) {
      const buf = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(ln);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*[-*]\s+/.test(ln)) {
      const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(ln)) {
      const items = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      out.push(`<ol>${items.join('')}</ol>`); continue;
    }
    if (!ln.trim()) { i++; continue; }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}
const mdLive = (t) => md((t.match(/^```/gm) || []).length % 2 ? t + '\n```' : t);

// ---------- 描画ヘルパー ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function scrollDown(force) { const near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160; if (near || force) chat.scrollTop = chat.scrollHeight; }
function add(node) { $('#empty')?.remove(); chat.appendChild(node); scrollDown(); return node; }
function clearChat() {
  chat.textContent = ''; cards.clear(); live = null;
  const e = el('div', 'empty'); e.id = 'empty';
  e.innerHTML = '<img src="icon.png" width="44" height="44" alt=""><h1>何をしましょうか？</h1><p>左の「ファイル」をクリックすると、入力欄に @パス が入ります。</p>';
  chat.appendChild(e);
}

function toolSummary(name, inp = {}) {
  const pick = inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.url ?? inp.description ?? inp.query ?? '';
  return String(pick || JSON.stringify(inp)).replace(/\s+/g, ' ').slice(0, 160);
}
const cards = new Map(); // tool_use_id -> card
function toolCard(block) {
  const d = el('details', 'card');
  const s = el('summary'); s.append(el('span', 'tn', block.name), el('span', 'ts', toolSummary(block.name, block.input)), el('span', 'st', '実行中…'));
  d.append(s); d.append(el('pre', '', JSON.stringify(block.input, null, 2)));
  cards.set(block.id, d); return d;
}
function fillResult(tr) {
  const d = cards.get(tr.tool_use_id); if (!d) return;
  const body = typeof tr.content === 'string' ? tr.content : (tr.content || []).map((c) => c.type === 'text' ? c.text : `[${c.type}]`).join('\n');
  d.classList.add(tr.is_error ? 'err' : 'ok');
  d.querySelector('.st').textContent = tr.is_error ? 'エラー' : '完了';
  d.append(el('pre', '', body.length > 20000 ? body.slice(0, 20000) + '\n… (省略)' : body));
}
function renderAssistantBlocks(box, blocks) {
  for (const b of blocks || []) {
    if (b.type === 'text' && b.text.trim()) box.append(Object.assign(el('div', 'md'), { innerHTML: md(b.text) }));
    else if (b.type === 'tool_use') box.append(toolCard(b));
  }
}
const META_USER = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook)/;
function renderUserContent(content) {
  if (typeof content === 'string') { if (!META_USER.test(content)) add(el('div', 'msg user', content)); return; }
  for (const b of content || []) {
    if (b.type === 'tool_result') fillResult(b);
    else if (b.type === 'text' && b.text.trim() && !META_USER.test(b.text)) add(el('div', 'msg user', b.text));
  }
}

// ---------- 通信 ----------
let ws, busy = false, live = null, sessionLabel = '', turnFailed = false, currentSession = null;
function setBusy(v) {
  const was = busy; busy = v; sendBtn.hidden = v; stopBtn.hidden = !v;
  statusEl.textContent = v ? '応答中…' : sessionLabel;
  if (was && !v) loadSessions();
}
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { statusEl.textContent = sessionLabel; };
  ws.onclose = () => { statusEl.textContent = '切断されました。ページを再読み込みしてください'; setBusy(false); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function handle(m) {
  if (m.type === 'hello') { if (!cwdEl.value) cwdEl.value = store.get('cwd', m.cwd); loadSessions(); loadRoot(); }
  else if (m.type === 'busy') setBusy(m.value);
  else if (m.type === 'error') { if (!turnFailed) add(el('div', 'err-box', m.message)); }
  else if (m.type === 'permission_request') askPermission(m);
  else if (m.type === 'sdk') onSdk(m.msg);
}

function onSdk(msg) {
  if (msg.type === 'system' && msg.subtype === 'init') { currentSession = msg.session_id; sessionLabel = `${msg.model}`; statusEl.textContent = busy ? '応答中…' : sessionLabel; return; }
  if (msg.type === 'stream_event') {
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (ev.type === 'message_start') { live = { box: add(el('div', 'msg assistant')), text: '', md: null }; }
    else if (ev.type === 'content_block_start' && live && ev.content_block.type === 'text') { live.text = ''; live.md = live.box.appendChild(el('div', 'md')); }
    else if (ev.type === 'content_block_delta' && live && ev.delta.type === 'text_delta') {
      if (!live.md) live.md = live.box.appendChild(el('div', 'md'));
      live.text += ev.delta.text;
      if (!live.raf) live.raf = requestAnimationFrame(() => { live.raf = 0; live.md.innerHTML = mdLive(live.text); scrollDown(); });
    }
    return;
  }
  if (msg.type === 'assistant') {
    let box;
    if (!msg.parent_tool_use_id && live) { box = live.box; box.textContent = ''; live = null; } else { box = add(el('div', 'msg assistant')); }
    renderAssistantBlocks(box, msg.message.content);
    if (!box.childNodes.length) box.remove();
    scrollDown(); return;
  }
  if (msg.type === 'user') {
    const c = msg.message && msg.message.content;
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') fillResult(b);
    return;
  }
  if (msg.type === 'result') {
    if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
      turnFailed = true;
      const authLike = /authenticate|OAuth|API key|401/i.test(msg.result || '');
      const hint = authLike ? '\n→ ターミナルで claude を起動して /login するか、API キー (ANTHROPIC_API_KEY) を設定してください。' : '';
      add(el('div', 'err-box', (msg.result || `終了: ${msg.subtype}`) + hint));
    }
    const sec = msg.duration_ms ? (msg.duration_ms / 1000).toFixed(1) + ' 秒' : '';
    const cost = typeof msg.total_cost_usd === 'number' ? ` · 目安 $${msg.total_cost_usd.toFixed(4)}` : '';
    const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
    const usage = Object.entries(msg.modelUsage || {}).map(([model, u]) =>
      ` · ${model.replace(/^claude-/, '')} 入力 ${k(u.inputTokens)} / キャッシュ読 ${k(u.cacheReadInputTokens)} / 書 ${k(u.cacheCreationInputTokens)} / 出力 ${k(u.outputTokens)}`).join('');
    add(el('div', 'meta', `${sec}${cost}${usage}`));
  }
}

function askPermission(p) {
  const card = el('div', 'card perm');
  const body = el('div', 'body');
  body.append(el('div', 'ask', p.title || `${p.displayName || p.toolName} の実行を許可しますか？`));
  if (p.reason) body.append(el('div', 'meta', p.reason));
  body.append(el('pre', '', p.input.command ?? p.input.file_path ?? JSON.stringify(p.input, null, 2)));
  const btns = el('div', 'btns');
  const decide = (allow, remember, label) => {
    ws.send(JSON.stringify({ type: 'permission', id: p.id, allow, remember }));
    btns.remove(); card.classList.add('done'); body.append(el('div', 'meta', label));
  };
  const ok = el('button', 'primary', '許可'); ok.onclick = () => decide(true, false, '許可しました');
  btns.append(ok);
  if (p.hasSuggestions) { const always = el('button', '', 'このセッションでは常に許可'); always.onclick = () => decide(true, true, '常に許可に設定しました'); btns.append(always); }
  const no = el('button', '', '拒否'); no.onclick = () => decide(false, false, '拒否しました');
  btns.append(no); body.append(btns); card.append(body); add(card);
}

// ---------- 入力 ----------
function send() {
  const text = input.value.trim(); if (!text || busy || ws.readyState !== 1) return;
  store.set('cwd', cwdEl.value); store.set('mode', modeEl.value); store.set('model', modelEl.value);
  turnFailed = false;
  add(el('div', 'msg user', text));
  ws.send(JSON.stringify({ type: 'send', text, cwd: cwdEl.value.trim(), permissionMode: modeEl.value, model: modelEl.value || undefined }));
  input.value = ''; autosize();
}
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
sendBtn.onclick = send;
stopBtn.onclick = () => ws.send(JSON.stringify({ type: 'interrupt' }));
modeEl.onchange = () => { store.set('mode', modeEl.value); if (busy) ws.send(JSON.stringify({ type: 'setMode', mode: modeEl.value })); };
modelEl.onchange = () => store.set('model', modelEl.value);

// ---------- サイドバー: 会話 ----------
const api = async (path, params) => {
  const r = await fetch(`${path}?${new URLSearchParams({ cwd: cwdEl.value.trim(), ...params })}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
};
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'たった今'; if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
}
async function loadSessions() {
  const box = $('#sessions');
  try {
    const list = await api('/api/sessions', {});
    box.textContent = '';
    if (!list.length) box.append(el('div', 'hint', 'このフォルダの会話はまだありません'));
    for (const s of list) {
      const d = el('div', 'sess' + (s.sessionId === currentSession ? ' on' : ''));
      d.append(el('div', 't', s.title), el('div', 'd', ago(s.lastModified)));
      d.onclick = () => openSession(s.sessionId);
      box.append(d);
    }
  } catch (e) { box.textContent = ''; box.append(el('div', 'hint', '一覧を取得できませんでした: ' + e.message)); }
}
async function openSession(id) {
  if (busy) return;
  try {
    const msgs = await api('/api/session', { id });
    clearChat(); $('#empty')?.remove();
    for (const m of msgs) {
      if (m.type === 'assistant') { const box = el('div', 'msg assistant'); renderAssistantBlocks(box, m.message && m.message.content); if (box.childNodes.length) add(box); }
      else if (m.type === 'user') renderUserContent(m.message && m.message.content);
    }
    currentSession = id; sessionLabel = ''; statusEl.textContent = '';
    ws.send(JSON.stringify({ type: 'resume', sessionId: id }));
    scrollDown(true); loadSessions();
  } catch (e) { add(el('div', 'err-box', '会話を開けませんでした: ' + e.message)); }
}
$('#new').onclick = () => { if (busy) return; ws.send(JSON.stringify({ type: 'newSession' })); currentSession = null; sessionLabel = ''; statusEl.textContent = ''; clearChat(); loadSessions(); input.focus(); };

// ---------- サイドバー: ファイル ----------
function insertAtCursor(text) {
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
  const pre = input.value.slice(0, s), post = input.value.slice(e);
  const sp = pre && !/\s$/.test(pre) ? ' ' : '';
  input.value = pre + sp + text + ' ' + post;
  const pos = (pre + sp + text + ' ').length; input.setSelectionRange(pos, pos); input.focus(); autosize();
}
const atRef = (rel) => (/\s/.test(rel) ? `@"${rel}"` : `@${rel}`);
async function fillDir(container, rel, depth) {
  container.textContent = '';
  let data; try { data = await api('/api/tree', { dir: rel }); } catch (e) { container.append(el('div', 'hint', e.message)); return; }
  if (!data.entries.length) container.append(el('div', 'hint', '(空)'));
  for (const ent of data.entries) {
    const childRel = rel === '.' ? ent.name : `${rel}/${ent.name}`;
    const row = el('div', `row ${ent.dir ? 'dir' : 'file'}`); row.style.paddingLeft = `${6 + depth * 14}px`;
    row.append(el('span', 'ch', ent.dir ? '▸' : ''), el('span', '', ent.name)); row.title = childRel;
    if (!ent.dir) { row.draggable = true; row.ondragstart = (ev) => ev.dataTransfer.setData('text/plain', atRef(childRel) + ' '); }
    container.append(row);
    if (ent.dir) {
      const sub = el('div'); sub.hidden = true; container.append(sub); let loaded = false;
      row.onclick = async () => {
        sub.hidden = !sub.hidden; row.querySelector('.ch').textContent = sub.hidden ? '▸' : '▾';
        if (!sub.hidden && !loaded) { loaded = true; await fillDir(sub, childRel, depth + 1); }
      };
    } else row.onclick = () => insertAtCursor(atRef(childRel));
  }
}
function loadRoot() { fillDir($('#tree'), '.', 0); }

function showTab(which) {
  const files = which === 'files';
  $('#pane-files').hidden = !files; $('#pane-sessions').hidden = files;
  $('#tab-files').classList.toggle('on', files); $('#tab-sessions').classList.toggle('on', !files);
  store.set('tab', which);
}
$('#tab-sessions').onclick = () => showTab('sessions');
$('#tab-files').onclick = () => showTab('files');
showTab(store.get('tab', 'sessions'));

// フォルダを変えたら、会話とツリーを読み込み直す
cwdEl.addEventListener('change', () => {
  if (busy) return;
  store.set('cwd', cwdEl.value);
  ws.send(JSON.stringify({ type: 'newSession' })); currentSession = null; clearChat(); loadSessions(); loadRoot();
});

connect();
input.focus();
