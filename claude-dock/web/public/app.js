// cdock web — フロントエンド (依存なし)
const $ = (s) => document.querySelector(s);
const NL = String.fromCharCode(10);
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
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(ln); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const td = (tag, c) => `<${tag}>${inline(c)}</${tag}>`;
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => td('th', c)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => td('td', c)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
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
  e.innerHTML = '<img src="icon.png" width="44" height="44" alt=""><h1>何をしましょうか？</h1><p>「ファイル」タブでクリックするとプレビュー、＠ で入力欄に @パス を入れられます。</p>';
  chat.appendChild(e);
}

function toolSummary(name, inp = {}) {
  const pick = inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.url ?? inp.description ?? inp.query ?? '';
  return String(pick || JSON.stringify(inp)).replace(/\s+/g, ' ').slice(0, 160);
}
const cards = new Map(); // tool_use_id -> card
function diffLines(wrap, mark, cls, text, max) {
  const lines = String(text ?? '').split('\n');
  for (const line of lines.slice(0, max)) { const d = el('div', `dl ${cls}`); d.textContent = `${mark} ${line}`; wrap.append(d); }
  if (lines.length > max) wrap.append(el('div', 'dl', `… 他 ${lines.length - max} 行`));
}
function diffBody(b) {
  const i = b.input || {};
  const edits = b.name === 'Edit' ? [i] : b.name === 'MultiEdit' ? (i.edits || []) : null;
  if (!edits && b.name !== 'Write') return null;
  const wrap = el('div', 'diff');
  wrap.append(el('div', 'dh', `${b.name === 'Write' ? '書き込み' : '編集'}: ${i.file_path || ''}`));
  if (b.name === 'Write') { diffLines(wrap, '+', 'add', i.content, 120); return wrap; }
  for (const e of edits) { diffLines(wrap, '-', 'del', e.old_string, 200); diffLines(wrap, '+', 'add', e.new_string, 200); }
  return wrap;
}
function toolCard(block) {
  const d = el('details', 'card');
  const s = el('summary'); s.append(el('span', 'tn', block.name), el('span', 'ts', toolSummary(block.name, block.input)), el('span', 'st', '実行中…'));
  d.append(s);
  const diff = diffBody(block);
  d.append(diff || el('pre', '', JSON.stringify(block.input, null, 2)));
  if (diff) d.open = true;
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
const META_USER = /^\s*(<(command-|local-command|system-reminder|user-prompt-submit-hook)|This session is being continued)/;
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
  if (was && !v) { loadSessions(); loadGit(); }
}
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { statusEl.textContent = sessionLabel; };
  ws.onclose = () => { statusEl.textContent = '切断されました。ページを再読み込みしてください'; setBusy(false); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function handle(m) {
  if (m.type === 'hello') { if (!cwdEl.value) cwdEl.value = store.get('cwd', m.cwd); loadSessions(); loadRoot(); loadCommands(); loadGit(); }
  else if (m.type === 'busy') setBusy(m.value);
  else if (m.type === 'error') { if (!turnFailed) add(el('div', 'err-box', m.message)); }
  else if (m.type === 'permission_request') askPermission(m);
  else if (m.type === 'sdk') onSdk(m.msg);
}

function onSdk(msg) {
  if (msg.type === 'system' && msg.subtype === 'init') { currentSession = msg.session_id; sessionLabel = `${msg.model}`; statusEl.textContent = busy ? '応答中…' : sessionLabel; return; }
  if (msg.type === 'system' && msg.subtype === 'local_command_output') { add(el('pre', 'localout', msg.content)); return; }
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const md = msg.compact_metadata || {};
    add(el('div', 'sysnote', `会話を要約しました${md.pre_tokens ? ` (${md.pre_tokens.toLocaleString()} → ${md.post_tokens ? md.post_tokens.toLocaleString() : '?'} トークン)` : ''}`)); return;
  }
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
  if (text === '/clear') { input.value = ''; autosize(); hideSlash(); $('#new').onclick(); return; } // 新しい会話
  hideSlash();
  store.set('cwd', cwdEl.value); store.set('mode', modeEl.value); store.set('model', modelEl.value);
  turnFailed = false;
  add(el('div', 'msg user', text));
  ws.send(JSON.stringify({ type: 'send', text, cwd: cwdEl.value.trim(), permissionMode: modeEl.value, model: modelEl.value || undefined }));
  input.value = ''; autosize();
}
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }
// ---------- スラッシュコマンド ----------
let commands = [], slashItems = [], slashIdx = 0;
const slashBox = $('#slash');
async function loadCommands() { try { commands = await api('/api/commands', {}); } catch { commands = []; } }
function hideSlash() { slashBox.hidden = true; slashItems = []; }
function updateSlash() {
  const m = /^\/([^\s]*)$/.exec(input.value);
  if (!m) return hideSlash();
  const q = m[1].toLowerCase();
  slashItems = commands.filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 40);
  if (!slashItems.length) return hideSlash();
  slashIdx = Math.min(slashIdx, slashItems.length - 1);
  slashBox.textContent = '';
  slashItems.forEach((c, i) => {
    const it = el('div', 'it' + (i === slashIdx ? ' on' : ''));
    const hint = c.argumentHint && c.argumentHint.length > 26 ? c.argumentHint.slice(0, 25) + '…' : c.argumentHint;
    it.append(el('span', 'nm', `/${c.name}`), ...(hint ? [el('span', 'ah', hint)] : []), el('span', 'ds', c.description));
    it.onmousedown = (ev) => { ev.preventDefault(); pickSlash(i); };
    slashBox.append(it);
  });
  slashBox.hidden = false;
  slashBox.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
}
function pickSlash(i) { const c = slashItems[i]; if (!c) return; input.value = `/${c.name} `; hideSlash(); autosize(); input.focus(); }
input.addEventListener('input', () => { autosize(); slashIdx = 0; updateSlash(); });
input.addEventListener('blur', () => setTimeout(hideSlash, 100));
input.addEventListener('keydown', (e) => {
  if (!slashBox.hidden && slashItems.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; return updateSlash(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; return updateSlash(); }
    if ((e.key === 'Tab' || e.key === 'Enter') && !e.isComposing) { e.preventDefault(); return pickSlash(slashIdx); }
    if (e.key === 'Escape') { e.preventDefault(); return hideSlash(); }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
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
      const t = el('div', 't', s.title);
      const ed = el('span', 'ed', '✎'); ed.title = '名前を変更';
      ed.onclick = (ev) => { ev.stopPropagation(); renameStart(d, t, s); };
      d.append(t, el('div', 'd', ago(s.lastModified)), ed);
      d.onclick = () => openSession(s.sessionId);
      box.append(d);
    }
  } catch (e) { box.textContent = ''; box.append(el('div', 'hint', '一覧を取得できませんでした: ' + e.message)); }
}
function renameStart(row, titleEl, s) {
  const inp = el('input', 'rn'); inp.value = s.title; titleEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (save && v && v !== s.title) {
      try {
        const r = await fetch(`/api/rename?${new URLSearchParams({ cwd: cwdEl.value.trim() })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.sessionId, title: v }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      } catch (e) { add(el('div', 'err-box', '名前を変更できませんでした: ' + e.message)); }
    }
    loadSessions();
  };
  inp.onclick = (ev) => ev.stopPropagation();
  inp.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) finish(true); else if (ev.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
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
    } else {
      const at = el('span', 'at', '＠'); at.title = '入力欄に @パス を挿入';
      at.onclick = (ev) => { ev.stopPropagation(); insertAtCursor(atRef(childRel)); };
      row.append(at);
      row.onclick = () => openPreview(childRel, row);
      row.ondblclick = () => insertAtCursor(atRef(childRel));
    }
  }
}
// ---------- プレビュー ----------
let previewRel = null;
const pv = { box: $('#preview'), name: $('#pname'), body: $('#pbody') };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const rawUrl = (rel) => `/api/raw?${new URLSearchParams({ cwd: cwdEl.value.trim(), path: rel })}`;
async function openPreview(rel, row) {
  document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel')); row?.classList.add('sel');
  previewRel = rel; pv.box.hidden = false; pv.name.textContent = rel; pv.body.textContent = '読み込み中…';
  let d; try { d = await api('/api/file', { path: rel }); } catch (e) { pv.body.textContent = ''; pv.body.append(el('div', 'note', e.message)); return; }
  if (previewRel !== rel) return;
  pv.body.textContent = ''; pv.body.scrollTop = 0;
  if (d.kind === 'text') {
    if (d.truncated) pv.body.append(el('div', 'note', `先頭 1MB のみ表示 (${fmtSize(d.size)})`));
    pv.body.append(el('pre', 'code', d.text));
  } else if (d.kind === 'markdown') {
    if (d.truncated) pv.body.append(el('div', 'note', `先頭 1MB のみ表示 (${fmtSize(d.size)})`));
    pv.body.append(Object.assign(el('div', 'md'), { innerHTML: md(d.text) }));
  } else if (d.kind === 'image') {
    const img = el('img'); img.alt = d.name; img.src = rawUrl(rel); pv.body.append(img);
  } else if (d.kind === 'pdf') {
    const f = el('iframe'); f.src = rawUrl(rel); pv.body.append(f);
  } else if (d.kind === 'pptx') {
    pv.body.append(el('div', 'note', `PowerPoint · ${d.slides.length} スライド (テキストのみ。画像・図形は表示されません)`));
    for (const sl of d.slides) {
      const c = el('div', 'slide'); c.append(el('h4', '', `SLIDE ${sl.n}`));
      sl.lines.forEach((t, i) => c.append(el('div', i === 0 ? 'l1' : 'ln', t)));
      if (!sl.lines.length) c.append(el('div', 'ln note', '(テキストなし)'));
      pv.body.append(c);
    }
  } else if (d.kind === 'docx') {
    pv.body.append(el('div', 'note', 'Word · テキストのみ'));
    for (const t of d.lines) pv.body.append(el('p', '', t));
  } else {
    pv.body.append(el('div', 'note', `${d.name} (${fmtSize(d.size)}) — ${d.note || 'プレビューできない形式です'}`));
  }
}
$('#pclose').onclick = () => { pv.box.hidden = true; previewRel = null; document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel')); };
$('#pinsert').onclick = () => { if (previewRel) insertAtCursor(atRef(previewRel)); };

function loadRoot() { fillDir($('#tree'), '.', 0); }

const TABS = ['sessions', 'files', 'git'];
function showTab(which) {
  for (const t of TABS) { $(`#pane-${t}`).hidden = t !== which; $(`#tab-${t}`).classList.toggle('on', t === which); }
  store.set('tab', which);
  if (which === 'git') loadGit();
}
for (const t of TABS) $(`#tab-${t}`).onclick = () => showTab(t);
showTab(store.get('tab', 'sessions'));

// ---------- サイドバー: Git の変更 ----------
const GIT_LABEL = { M: '変更', A: '追加', D: '削除', R: '名前変更', '?': '未追跡', U: '競合' };
function gitMark(xy) { const c = xy === '??' ? '?' : (xy[0] !== ' ' ? xy[0] : xy[1]); return c === '?' ? 'A' : c; }
async function loadGit() {
  const list = $('#gitlist'), br = $('#gitbranch'), badge = $('#gitcount');
  let d; try { d = await api('/api/git/status', {}); } catch (e) { list.textContent = ''; list.append(el('div', 'hint', e.message)); return; }
  list.textContent = ''; badge.hidden = true;
  if (!d.repo) { br.textContent = ''; list.append(el('div', 'hint', 'このフォルダは Git リポジトリではありません')); return; }
  br.textContent = `⎇ ${d.branch || '(detached)'}`;
  if (!d.files.length) { list.append(el('div', 'hint', '変更はありません')); return; }
  badge.textContent = d.files.length; badge.hidden = false;
  for (const f of d.files) {
    const row = el('div', 'gitrow'); const m = gitMark(f.xy);
    row.title = `${GIT_LABEL[f.xy === '??' ? '?' : m] || m}: ${f.path}`;
    row.append(el('span', `gs ${m}`, f.xy === '??' ? '?' : m), el('span', 'gp', f.path));
    row.onclick = () => { document.querySelectorAll('.gitrow.sel').forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); openDiff(f.path, f.xy === '??'); };
    list.append(row);
  }
}
$('#gitrefresh').onclick = loadGit;
async function openDiff(rel, untracked) {
  previewRel = null; pv.box.hidden = false; pv.name.textContent = `${untracked ? '未追跡' : '差分'}: ${rel}`; pv.body.textContent = '読み込み中…';
  let d; try { d = await api('/api/git/diff', { path: rel }); } catch (e) { pv.body.textContent = ''; pv.body.append(el('div', 'note', e.message)); return; }
  pv.body.textContent = ''; pv.body.scrollTop = 0;
  const wrap = el('div', 'diff'); wrap.style.maxHeight = 'none'; wrap.style.border = '1px solid var(--rule)'; wrap.style.borderRadius = '10px';
  const lines = d.text.split(NL); if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) wrap.append(el('div', 'dl', '(差分はありません)'));
  for (const ln of lines) {
    const cls = d.untracked ? 'add' : ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ') ? 'dh2' : ln.startsWith('@@') ? 'hunk' : ln[0] === '+' ? 'add' : ln[0] === '-' ? 'del' : '';
    const row = el('div', `dl ${cls}`); row.textContent = d.untracked ? `+ ${ln}` : ln; wrap.append(row);
  }
  pv.body.append(wrap);
}

// フォルダを変えたら、会話とツリーを読み込み直す
cwdEl.addEventListener('change', () => {
  if (busy) return;
  store.set('cwd', cwdEl.value);
  ws.send(JSON.stringify({ type: 'newSession' })); currentSession = null; clearChat(); loadSessions(); loadRoot(); loadCommands(); loadGit();
});

// ---------- チャットの文字サイズ (A− / A＋、記憶する) ----------
const FS_MIN = 11, FS_MAX = 20, FS_DEFAULT = 14;
function setChatFs(n) {
  const v = Math.max(FS_MIN, Math.min(FS_MAX, n));
  document.documentElement.style.setProperty('--chat-fs', `${v}px`); store.set('chatFs', String(v));
  $('#fs-down').disabled = v <= FS_MIN; $('#fs-up').disabled = v >= FS_MAX; $('.fs').title = `チャットの文字サイズ: ${v}px (ダブルクリックで初期値)`;
  return v;
}
let chatFs = setChatFs(Number(store.get('chatFs', FS_DEFAULT)) || FS_DEFAULT);
$('#fs-down').onclick = () => { chatFs = setChatFs(chatFs - 1); };
$('#fs-up').onclick = () => { chatFs = setChatFs(chatFs + 1); };
$('.fs').ondblclick = () => { chatFs = setChatFs(FS_DEFAULT); };

// ---------- ペイン幅の変更 (ドラッグ / ←→ キー / ダブルクリックで初期値) ----------
function setupGrip(grip, pane, cssVar, storeKey, side, min, maxFn) {
  const clamp = (w) => Math.round(Math.max(min, Math.min(maxFn(), w)));
  const apply = (w) => document.documentElement.style.setProperty(cssVar, `${clamp(w)}px`);
  const saved = Number(store.get(storeKey, ''));
  if (saved) apply(saved);
  const current = () => pane.getBoundingClientRect().width;
  const persist = () => store.set(storeKey, String(Math.round(current())));
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
    grip.classList.add('drag'); document.body.classList.add('resizing');
    const move = (ev) => { const r = pane.getBoundingClientRect(); apply(side === 'left' ? ev.clientX - r.left : r.right - ev.clientX); };
    const up = () => {
      grip.classList.remove('drag'); document.body.classList.remove('resizing');
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      persist();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => { document.documentElement.style.removeProperty(cssVar); try { localStorage.removeItem(storeKey); } catch { /* 無視 */ } });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault();
    const step = (e.shiftKey ? 60 : 16) * (e.key === 'ArrowRight' ? 1 : -1);
    apply(current() + (side === 'left' ? step : -step)); persist();
  });
}
// 会話欄 (中央) が 340px を下回らないように、もう一方のペインの幅を引いた残りを上限にする
const MIN_MAIN = 340;
const otherW = (el) => (el.hidden ? 0 : el.getBoundingClientRect().width);
setupGrip($('#grip-side'), $('#side'), '--side-w', 'sideW', 'left', 180, () => Math.min(560, window.innerWidth - otherW($('#preview')) - MIN_MAIN));
setupGrip($('#grip-prev'), $('#preview'), '--prev-w', 'prevW', 'right', 260, () => window.innerWidth - otherW($('#side')) - MIN_MAIN);

connect();
input.focus();
