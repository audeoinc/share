import { renderMarkdown } from './md.js';
// Claude Rogue — フロントエンド (依存なし)
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

// ---------- Markdown (md.js) ----------
const md = (src, opts) => renderMarkdown(src, opts || {});
const mdLive = (t) => md((t.match(/^```/gm) || []).length % 2 ? `${t}\n${'`'.repeat(3)}` : t);

// ---------- 描画ヘルパー ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
// 末尾に張り付くか: 「内容が増えたあと」の位置では判定せず、利用者が最後にスクロールした位置で決める
// (長い出力が一度に増えると、増えたあとの距離が大きくなり、自動で下まで行かなくなるため)
let stick = true;
chat.addEventListener('scroll', () => { stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80; }, { passive: true });
function scrollDown(force) { if (force) stick = true; if (stick) chat.scrollTop = chat.scrollHeight; }
let scrollQueued = false;
const queueScroll = () => { if (scrollQueued) return; scrollQueued = true; setTimeout(() => { scrollQueued = false; scrollDown(); }, 30); };
new MutationObserver(queueScroll).observe(chat, { childList: true, subtree: true, characterData: true }); // 文字が流れて増えたとき、カードが開いたとき
chat.addEventListener('load', queueScroll, true); // 画像が読み込まれて高さが増えたとき
function add(node) { $('#empty')?.remove(); chat.insertBefore(node, progressEl); scrollDown(); return node; }
// ---------- 進行中の表示 (スピナー + 状態 + 経過秒数)。会話の最後に出る ----------
const progressEl = el('div', 'progress'); progressEl.hidden = true; chat.appendChild(progressEl);
const prog = { running: new Map(), phase: 'idle', phaseT0: 0, compact: false, perm: 0, open: false, timer: null, key: '' };
const fmtSec = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
function progSetPhase(p) { if (prog.phase !== p) { prog.phase = p; prog.phaseT0 = Date.now(); } renderProgress(); }
function progStart() {
  prog.running.clear(); prog.compact = false; prog.perm = 0; prog.open = false; prog.phase = 'wait'; prog.phaseT0 = Date.now(); prog.key = '';
  clearInterval(prog.timer); prog.timer = setInterval(renderProgress, 1000); renderProgress();
}
function progStop() { clearInterval(prog.timer); prog.timer = null; prog.running.clear(); prog.phase = 'idle'; prog.perm = 0; prog.compact = false; prog.key = ''; progressEl.hidden = true; progressEl.textContent = ''; }
function progToolStart(b) { prog.running.set(b.id, { name: b.name, summary: toolSummary(b.name, b.input), input: b.input, t0: Date.now(), detail: '' }); renderProgress(); }
function progToolDone(id) { prog.running.delete(id); renderProgress(); }
function progToolProgress(m) {
  let t = prog.running.get(m.tool_use_id);
  if (!t) { t = { name: m.tool_name, summary: '', input: null, t0: Date.now(), detail: '' }; prog.running.set(m.tool_use_id, t); }
  t.t0 = Date.now() - (m.elapsed_time_seconds || 0) * 1000; renderProgress(); // 実際の経過時間に合わせる
}
function progTask(m) { const t = m.tool_use_id && prog.running.get(m.tool_use_id); if (t && m.description) { t.detail = m.description; renderProgress(); } }
function currentActivity() {
  if (prog.perm > 0) return { label: '許可の確認待ち', detail: 'ボタンで許可・拒否してください', t0: prog.phaseT0, still: true };
  if (prog.running.size) {
    const all = [...prog.running.values()]; const t = all[all.length - 1];
    const sub = t.name === 'Task' || t.name === 'Agent';
    return { label: sub ? 'サブエージェント実行中' : '実行中', name: t.name, detail: t.detail || t.summary, t0: t.t0, more: all.length - 1, input: all };
  }
  if (prog.compact) return { label: '会話を要約中…', detail: '', t0: prog.phaseT0 };
  if (prog.phase === 'prep') return { label: '準備中', name: prog.prepName || '', detail: '', t0: prog.phaseT0 };
  if (prog.phase === 'text') return { label: '回答中…', detail: '', t0: prog.phaseT0 };
  return { label: prog.phase === 'think' ? '考え中…' : '応答を待っています…', detail: '', t0: prog.phaseT0 };
}
function renderProgress() {
  if (!busy && prog.phase === 'idle') { progressEl.hidden = true; return; }
  const a = currentActivity(); progressEl.hidden = false;
  const key = `${a.label}|${a.name || ''}|${a.detail}|${a.more || 0}|${a.still ? 1 : 0}|${prog.open ? 1 : 0}`;
  if (key !== prog.key) { // 状態が変わったときだけ組み立て直す (秒数は下で更新するだけ)
    prog.key = key; progressEl.textContent = ''; progressEl.classList.toggle('still', !!a.still);
    const row = el('div', 'prow');
    const spin = el('span', 'spin'); for (let i = 0; i < 4; i++) spin.append(el('i'));
    row.append(spin, el('span', 'plab', a.label));
    if (a.name) row.append(el('span', 'pname', a.name));
    if (a.detail) row.append(el('span', 'pdet', a.detail));
    if (a.more > 0) row.append(el('span', 'pmore', `＋${a.more}`));
    row.append(el('span', 'psec', ''), el('span', `pchev${prog.open ? ' open' : ''}`, '›'));
    row.onclick = () => { if (!a.input) return; prog.open = !prog.open; prog.key = ''; renderProgress(); };
    row.style.cursor = a.input ? 'pointer' : 'default';
    progressEl.append(row);
    if (prog.open && a.input) {
      const pre = el('pre', 'pdetail');
      pre.textContent = a.input.map((t) => `${t.name}  ${typeof t.input === 'object' && t.input ? (t.input.command ?? t.input.file_path ?? t.input.pattern ?? JSON.stringify(t.input, null, 2)) : t.summary}`).join('\n\n');
      progressEl.append(pre);
    }
    scrollDown();
  }
  const sec = progressEl.querySelector('.psec'); if (sec) sec.textContent = fmtSec(Date.now() - a.t0);
}

function clearChat() {
  chat.textContent = ''; cards.clear(); live = null;
  const e = el('div', 'empty'); e.id = 'empty';
  e.innerHTML = '<img src="icon.png" width="44" height="44" alt=""><h1>何をしましょうか？</h1><p>「ファイル」タブでクリックするとプレビュー、＠ で入力欄に @パス を入れられます。</p>';
  chat.appendChild(e); chat.appendChild(progressEl); progStop();
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
  if (typeof content === 'string') { if (!META_USER.test(content)) historyUser(content); return; }
  for (const b of content || []) {
    if (b.type === 'tool_result') fillResult(b);
    else if (b.type === 'text' && b.text.trim() && !META_USER.test(b.text)) historyUser(b.text);
  }
}
function historyUser(text) {
  const s = splitAttachments(text);
  add(userBubble(s.text, s.files.map((p) => { const dir = /[\\/]$/.test(p); const q = dir ? p.slice(0, -1) : p; return { name: q.split('/').pop().split(String.fromCharCode(92)).pop() + (dir ? '/' : ''), dir, status: 'ready' }; })));
}

// ---------- 通信 ----------
let serverFeatures = new Set();
let ws, busy = false, live = null, sessionLabel = '', turnFailed = false, currentSession = null;
function setBusy(v) {
  const was = busy; busy = v; sendBtn.hidden = v; stopBtn.hidden = !v;
  statusEl.textContent = v ? '応答中…' : sessionLabel;
  if (v && !was) progStart(); else if (!v) progStop();
  if (was && !v) { loadSessions(); loadGit(); invalidateIndex(); refreshTree(); if (queued) setTimeout(sendQueued, 80); }
}
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { statusEl.textContent = sessionLabel; };
  ws.onclose = () => { statusEl.textContent = '切断されました。ページを再読み込みしてください'; setBusy(false); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function handle(m) {
  if (m.type === 'hello') { serverFeatures = new Set(m.features || []); setupShells(m.shells || []); if (m.claude && m.claude.warn) add(el('div', 'err-box', m.claude.warn)); if (m.claude) statusEl.dataset.cc = `${m.claude.source === 'installed' ? 'PC の' : '同梱の'} Claude Code ${m.claude.version}`; if (!cwdEl.value) cwdEl.value = store.get('cwd', m.cwd); lastGoodCwd = cwdEl.value; renderCrumbs(); refreshParent(); loadSessions(); loadRoot(); loadCommands(); loadGit(); watchCwd(); }
  else if (m.type === 'busy') setBusy(m.value);
  else if (m.type === 'injected') { if (pendingInject) add(userBubble(pendingInject.text, pendingInject.ready)); pendingInject = null; } // 取り込まれたら、いまの応答の途中に、発言として表示する
  else if (m.type === 'inject_rejected') { const q = pendingInject; pendingInject = null; if (q) { queued = q; renderQueued(); if (!busy) sendQueued(); else toast('いまの応答が終わったら、この発言を送ります'); } } // 応答がちょうど終わっていた場合など
  else if (m.type === 'notice') add(el('div', 'err-box', m.message));
  else if (m.type === 'fs') onFsChange(m);
  else if (m.type === 'run_out') { if (m.id === run.id) runAppend(m.data); }
  else if (m.type === 'run_end') runEnd(m);
  else if (m.type === 'watch_state') { $('#treerefresh').title = m.active ? '更新 (自動でも更新されます)' : (m.reason || '更新'); }
  else if (m.type === 'error') { if (!turnFailed) add(el('div', 'err-box', m.message)); }
  else if (m.type === 'permission_request') askPermission(m);
  else if (m.type === 'sdk') onSdk(m.msg);
}

function onSdk(msg) {
  if (msg.type === 'system' && msg.subtype === 'init') { currentSession = msg.session_id; lastModelId = msg.model || ''; lastEffort = msg.effort || (effortEl.disabled ? '' : effortShown()) || ''; /* 「既定」のときの実際の値は init には含まれないので、選んだ値だけを出す */ sessionLabel = modelName(lastModelId) + (lastEffort ? ` · ${lastEffort}` : ''); statusEl.title = `${lastModelId}${lastEffort ? ` / effort: ${lastEffort}` : ''}`; if (modelEl.value === '') setDefaultLabel(lastModelId); syncEffort(); statusEl.textContent = busy ? '応答中…' : sessionLabel; return; }
  if (msg.type === 'system' && msg.subtype === 'local_command_output') { add(el('pre', 'localout', msg.content)); return; }
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const md = msg.compact_metadata || {};
    add(el('div', 'sysnote', `会話を要約しました${md.pre_tokens ? ` (${md.pre_tokens.toLocaleString()} → ${md.post_tokens ? md.post_tokens.toLocaleString() : '?'} トークン)` : ''}`)); return;
  }
  if (msg.type === 'tool_progress') { progToolProgress(msg); return; }
  if (msg.type === 'system' && msg.subtype === 'status') { prog.compact = msg.status === 'compacting'; renderProgress(); return; }
  if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_progress')) { progTask(msg); return; }
  if (msg.type === 'stream_event') {
    if (msg.parent_tool_use_id) return;
    const ev = msg.event;
    if (ev.type === 'message_start') { live = { box: add(el('div', 'msg assistant')), text: '', md: null }; progSetPhase('wait'); }
    else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') progSetPhase('think');
    else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') { prog.prepName = ev.content_block.name; progSetPhase('prep'); }
    else if (ev.type === 'content_block_start' && live && ev.content_block.type === 'text') { live.text = ''; live.md = live.box.appendChild(el('div', 'md')); progSetPhase('text'); }
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
    for (const b of msg.message.content || []) if (b.type === 'tool_use') progToolStart(b);
    if (!msg.parent_tool_use_id) progSetPhase('wait');
    if (!box.childNodes.length) box.remove();
    scrollDown(); return;
  }
  if (msg.type === 'user') {
    const c = msg.message && msg.message.content;
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') { fillResult(b); progToolDone(b.tool_use_id); }
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
  prog.perm++; renderProgress();
  const card = el('div', 'card perm');
  const body = el('div', 'body');
  body.append(el('div', 'ask', p.title || `${p.displayName || p.toolName} の実行を許可しますか？`));
  if (p.reason) body.append(el('div', 'meta', p.reason));
  body.append(el('pre', '', p.input.command ?? p.input.file_path ?? JSON.stringify(p.input, null, 2)));
  const btns = el('div', 'btns');
  const decide = (allow, remember, label) => {
    ws.send(JSON.stringify({ type: 'permission', id: p.id, allow, remember })); prog.perm = Math.max(0, prog.perm - 1); prog.phaseT0 = Date.now(); prog.running.forEach((t) => { t.t0 = Date.now(); }); renderProgress(); // 許可を待っていた時間は含めない
    btns.remove(); card.classList.add('done'); body.append(el('div', 'meta', label));
  };
  const ok = el('button', 'primary', '許可'); ok.onclick = () => decide(true, false, '許可しました');
  btns.append(ok);
  if (p.hasSuggestions) { const always = el('button', '', 'このセッションでは常に許可'); always.onclick = () => decide(true, true, '常に許可に設定しました'); btns.append(always); }
  const no = el('button', '', '拒否'); no.onclick = () => decide(false, false, '拒否しました');
  btns.append(no); body.append(btns); card.append(body); add(card);
}

// ---------- 入力 ----------
// 応答中に打った発言は、いったん「待機中」に置く。応答が終わったら自動で送る。「今すぐ送信」なら、応答を止めて、すぐ送る
let queued = null; // { text, ready }
function renderQueued() {
  const box = $('#queued'); box.textContent = ''; box.hidden = !queued; if (!queued) return;
  const now = el('button', 'send mini', '今すぐ送信'); now.type = 'button'; now.title = 'いまの作業は止めずに、この発言を取り込ませます (Claude が次の区切りで読んで、続けます)';
  now.onclick = () => injectQueued();
  const stopSend = el('button', 'ghost mini', '止めて送信'); stopSend.type = 'button'; stopSend.title = 'いまの応答を止めて、この発言を新しい応答として送ります';
  stopSend.onclick = () => { if (busy && ws.readyState === 1) ws.send(JSON.stringify({ type: 'interrupt' })); };
  const del = el('button', 'ghost mini', '取り消し'); del.type = 'button'; del.title = '待機中の発言を、入力欄に戻します';
  del.onclick = () => unqueue();
  box.append(el('span', 'qlab', '待機中'), el('span', 'qtx', queued.text.replace(/\s+/g, ' ')), now, stopSend, del);
}
function unqueue() { // 待機中の発言を入力欄に戻す (添付も戻す)
  if (!queued) return; const q = queued; queued = null; renderQueued();
  input.value = q.text + (input.value ? '\n' + input.value : ''); autosize(); attachments = [...q.ready, ...attachments]; renderAttach(); input.focus();
}
let pendingInject = null; // 取り込みを頼んだ発言 (サーバーが断ったら、通常の送信に戻す)
function injectQueued() { // 応答を止めずに、待機中の発言を取り込ませる
  if (!queued || !busy || !ws || ws.readyState !== 1) return;
  if (!serverFeatures.has('inject')) { toast('サーバーが古いため、取り込み送信はできません。「止めて送信」を使うか、再起動してください'); return; }
  const q = queued; queued = null; renderQueued(); pendingInject = q;
  ws.send(JSON.stringify({ type: 'inject', text: q.text, attachments: q.ready.map((a) => (a.rel ? { rel: a.rel } : { path: a.path })), cwd: cwdEl.value.trim() }));
}
function sendQueued() {
  if (!queued) return; const q = queued; queued = null; renderQueued();
  if (!ws || ws.readyState !== 1) { queued = q; unqueue(); return; }
  send(q);
}
function send(over) {
  const ready = over ? over.ready : attachments.filter((a) => a.status === 'ready');
  if (!over && attachments.some((a) => a.status === 'uploading')) return; // アップロード中は送らない
  const text = over ? over.text : (input.value.trim() || (ready.length ? '添付したファイルを確認してください。' : ''));
  if (text.startsWith('!') && !ready.length && text.slice(1).trim()) { // 「!コマンド」は Claude に送らず、「実行」タブで実行する (Claude の応答中でも可)
    if (run.id) { showTab('run'); runStatus('実行中のコマンドがあります。終わるのを待つか、停止してください', 'bad'); return; }
    input.value = ''; autosize(); hideSlash(); showTab('run'); $('#runcmd').value = text.slice(1).trim(); runStart(); return;
  }
  const em = /^\/effort(?:\s+(\S+))?\s*$/i.exec(text); // 「/effort」は画面上部の選択と同じものを操作する (Claude には送らない)
  if (em && !ready.length && !over) {
    input.value = ''; autosize(); hideSlash();
    const arg = (em[1] || '').toLowerCase();
    if (!arg) { if (effortEl.disabled) toast('このモデルは effort に対応していません'); else { if (effortPop) closeEffortPop(); openEffortPop(); } }
    else if (effortEl.disabled) toast('このモデルは effort に対応していません');
    else {
      const v = arg === 'auto' || arg === 'default' ? '' : arg; const opt = [...effortEl.options].find((o) => o.value === v);
      if (!opt || opt.disabled) toast(`「${arg}」は、このモデルでは使えません`);
      else { setEffort(v); toast(`effort を ${v || '既定'} にしました (次の発言から)`); }
    }
    return;
  }
  if (busy && text && !over && ws.readyState === 1 && text !== '/clear') { // 応答中: 待機に置く (続けて打てば、同じ待機に足す)
    queued = { text: queued ? `${queued.text}\n${text}` : text, ready: [...(queued ? queued.ready : []), ...ready] };
    input.value = ''; autosize(); attachments = []; renderAttach(); renderQueued(); return;
  }
  if (!text || busy || ws.readyState !== 1) return;
  if (ready.length && !serverFeatures.has('attach')) { add(el('div', 'err-box', 'サーバーが古いため、添付を送れません。start.cmd で起動し直してください。')); return; }
  if (cwdEl.classList.contains('invalid')) { add(el('div', 'err-box', 'フォルダが見つかりません。上部の「フォルダ」を確認してください。')); return; }
  if (text === '/clear') { input.value = ''; autosize(); hideSlash(); $('#new').onclick(); return; } // 新しい会話
  hideSlash();
  store.set('cwd', cwdEl.value); store.set('mode', modeEl.value); store.set('model', modelEl.value);
  turnFailed = false;
  add(userBubble(text, ready));
  ws.send(JSON.stringify({ type: 'send', text, cwd: cwdEl.value.trim(), permissionMode: modeEl.value, model: modelEl.value || undefined, effort: effortEl.disabled ? undefined : (effortEl.value || undefined), attachments: ready.map((a) => (a.rel ? { rel: a.rel } : { path: a.path })) }));
  if (!over) { input.value = ''; autosize(); attachments = []; renderAttach(); }
}
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }
// ---------- スラッシュコマンド ----------
let commands = [], slashItems = [], slashIdx = 0;
const slashBox = $('#slash');
async function loadCommands() { try { commands = await api('/api/commands', {}); } catch { commands = []; } loadModels(); }
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
stopBtn.onclick = () => { ws.send(JSON.stringify({ type: 'interrupt' })); unqueue(); }; // 止めたときは、待機中の発言を送らず、入力欄に戻す
modeEl.onchange = () => { store.set('mode', modeEl.value); if (busy) ws.send(JSON.stringify({ type: 'setMode', mode: modeEl.value })); };
modelEl.onchange = () => { syncEffort(); store.set('model', modelEl.value); if (modelEl.value === '' && lastModelId) setDefaultLabel(lastModelId); };

// ---------- モデルの選択 (SDK が返す実際の一覧。「既定」が何になるかも表示する) ----------
let models = [], lastModelId = '', lastEffort = '';
// ---------- effort (思考の深さ): スライダーで選ぶ。選んだモデルが対応するレベルだけ選べる ----------
// 状態は、非表示の <select id="effort"> が持つ。value が空 = 「既定」(モデルの標準。おすすめの値が分かるモデルでは、その値を添える)
const effortEl = $('#effort');
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const recommendedEffort = () => { // モデルごとの「おすすめ」。SDK からは取れないので、確認できたものだけ持つ
  const m = models.find((x) => x.value === (modelEl.value || 'default')); const id = m ? `${m.resolved} ${m.name}` : lastModelId;
  return /sonnet-5-5|Sonnet 5\.5/.test(id) ? 'medium' : '';
};
const effortLevelsNow = () => { const m = models.find((x) => x.value === (modelEl.value || 'default')); return m && Array.isArray(m.efforts) ? m.efforts : null; }; // null = 不明 (すべて許可)
function effortShown() { const rec = recommendedEffort(); return effortEl.value || rec; }
function syncEffort() {
  const levels = effortLevelsNow();
  for (const o of effortEl.options) { if (o.value) o.disabled = !!levels && !levels.includes(o.value); }
  effortEl.disabled = !!levels && levels.length === 0; // 対応しないモデル
  if (effortEl.value && effortEl.selectedOptions[0]?.disabled && levels && levels.length) { effortEl.value = ''; store.set('effort', ''); } // 選んでいたレベルに対応しないモデルへ変えたときは、「既定」に戻す
  const b = $('#effortbtn'); const v = effortEl.value, rec = recommendedEffort();
  b.disabled = effortEl.disabled;
  b.textContent = effortEl.disabled ? 'effort: 非対応' : v ? `effort: ${v}` : rec ? `effort: ${rec} (既定)` : 'effort: 既定';
  b.title = effortEl.disabled ? 'このモデルは effort に対応していません' : '思考の深さ (effort)。高いほど深く考えますが、時間と費用が増えます。クリックで変更 (/effort でも開きます)';
  if (effortPop) renderEffortPop();
}
effortEl.value = store.get('effort', ''); if (effortEl.value !== store.get('effort', '')) effortEl.value = '';
function setEffort(v) { effortEl.value = v; store.set('effort', v); syncEffort(); }
let effortPop = null;
function closeEffortPop() { if (!effortPop) return; effortPop.remove(); effortPop = null; document.removeEventListener('mousedown', effortOutside, true); document.removeEventListener('keydown', effortKey, true); }
function effortOutside(e) { if (effortPop && !effortPop.contains(e.target) && e.target !== $('#effortbtn')) closeEffortPop(); }
function effortKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeEffortPop(); } }
function renderEffortPop() {
  const pop = effortPop; if (!pop) return; pop.textContent = '';
  const levels = effortLevelsNow() || EFFORT_LEVELS; const cur = effortShown(); const rec = recommendedEffort();
  const head = el('div', 'ep-head'); head.append(el('span', 'ep-t', 'エフォート'), el('span', 'ep-v', cur || '既定')); pop.append(head);
  const ends = el('div', 'ep-ends'); ends.append(el('span', '', '高速'), el('span', '', '高精度')); pop.append(ends);
  const track = el('div', 'ep-track'); const slider = el('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(EFFORT_LEVELS.length - 1); slider.step = '1';
  slider.value = String(Math.max(0, EFFORT_LEVELS.indexOf(cur || rec || 'high'))); slider.setAttribute('aria-label', 'effort');
  slider.oninput = () => { // 対応しないレベルは、近い対応レベルへ寄せる
    let i = Number(slider.value); if (!levels.includes(EFFORT_LEVELS[i])) { const ok = EFFORT_LEVELS.map((l, k) => [k, l]).filter(([, l]) => levels.includes(l)); i = ok.reduce((b, [k]) => (Math.abs(k - i) < Math.abs(b - i) ? k : b), ok[0][0]); slider.value = String(i); }
    setEffort(EFFORT_LEVELS[i]);
  };
  const ticks = el('div', 'ep-ticks'); EFFORT_LEVELS.forEach((l) => { const t = el('span', 'ep-tick' + (levels.includes(l) ? '' : ' off') + (l === cur ? ' on' : ''), l); ticks.append(t); });
  track.append(slider); pop.append(track, ticks);
  if (rec) { const r = el('div', 'ep-rec'); r.style.left = `calc(${(EFFORT_LEVELS.indexOf(rec) / (EFFORT_LEVELS.length - 1)) * 100}% )`; r.textContent = 'おすすめ'; const w = el('div', 'ep-recwrap'); w.append(r); pop.append(w); }
  const foot = el('div', 'ep-foot'); const reset = el('button', 'ghost mini', rec ? `既定 (${rec}) に戻す` : '既定に戻す'); reset.type = 'button'; reset.disabled = !effortEl.value; reset.onclick = () => setEffort('');
  foot.append(reset); pop.append(foot);
}
function openEffortPop() {
  if (effortEl.disabled) return; if (effortPop) return closeEffortPop();
  effortPop = el('div', 'effortpop'); document.body.append(effortPop); renderEffortPop();
  const r = $('#effortbtn').getBoundingClientRect(); effortPop.style.top = `${Math.round(r.bottom + 6)}px`; effortPop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  document.addEventListener('mousedown', effortOutside, true); document.addEventListener('keydown', effortKey, true);
}
$('#effortbtn').onclick = openEffortPop;
const modelName = (id) => { const m = models.find((x) => x.value !== 'default' && (x.resolved === id || x.value === id)) || models.find((x) => x.resolved === id); return m ? m.name : id; };
function defaultName() {
  const d = models.find((x) => x.value === 'default'); if (!d) return '';
  const hit = models.find((x) => x.value !== 'default' && x.resolved === d.resolved);
  return hit ? hit.name : (d.description || '').split(' · ')[0] || d.resolved;
}
function setDefaultLabel(id) { const o = modelEl.querySelector('option[value=""]'); if (o) o.textContent = `既定 → ${modelName(id)}`; }
function fillModels() {
  if (!models.length) return;
  const keep = modelEl.value || store.get('model', '');
  modelEl.textContent = '';
  const opt = (m, label) => { const o = el('option', '', label); o.value = m.value; o.title = `${m.resolved} — ${m.description}`; return o; };
  const def = el('option', '', `既定 → ${defaultName()}`); def.value = ''; def.title = '設定に従う (サブスクリプション / 設定ファイルの指定)'; modelEl.append(def);
  const featured = ['opus', 'fable', 'sonnet', 'haiku']; const rest = models.filter((m) => m.value !== 'default' && !featured.includes(m.value));
  for (const v of featured) { const m = models.find((x) => x.value === v); if (m) modelEl.append(opt(m, m.name)); }
  if (rest.length) { const g = el('optgroup'); g.label = 'ほかのモデル'; for (const m of rest) g.append(opt(m, m.name)); modelEl.append(g); }
  // 以前の保存値 (完全なモデル ID) も、一覧の別名に対応づけて引き継ぐ
  const byResolved = models.find((m) => m.value !== 'default' && keep && (m.resolved === keep || m.resolved.startsWith(keep)));
  const target = [...modelEl.options].some((o) => o.value === keep) ? keep : byResolved ? byResolved.value : '';
  modelEl.value = target; store.set('model', target);
  if (lastModelId && !target) setDefaultLabel(lastModelId);
  syncEffort();
}
async function loadModels() { try { models = await api('/api/models', {}); } catch { models = []; } fillModels(); }

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
// 会話の一覧: すべてのフォルダの会話を新しい順に出す。選ぶと、その会話のフォルダ (とブランチ) へ戻って続きを開く
let sessAll = [];
const normDir = (x) => String(x || '').split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
const dirLeaf = (x) => String(x || "").split(/[\\/]+/).filter(Boolean).pop() || String(x || "");
async function loadSessions() {
  const box = $('#sessions');
  try { sessAll = await api('/api/sessions', {}); renderSessions(); }
  catch (e) { box.textContent = ''; box.append(el('div', 'hint', '一覧を取得できませんでした: ' + e.message)); }
}
function renderSessions() {
  const box = $('#sessions'); box.textContent = '';
  const q = $('#sessq').value.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const list = sessAll.filter((s) => { const hay = `${splitAttachments(s.title).text} ${s.cwd} ${s.gitBranch}`.toLowerCase(); return terms.every((t) => hay.includes(t)); });
  if (!list.length) box.append(el('div', 'hint', q ? '一致する会話がありません' : '会話はまだありません'));
  for (const s of list) {
    const d = el('div', 'sess' + (s.sessionId === currentSession ? ' on' : '') + (s.exists ? '' : ' gone'));
    const t = el('div', 't', splitAttachments(s.title).text.trim() || s.title);
    const ed = el('span', 'ed', '✎'); ed.title = '名前を変更';
    ed.onclick = (ev) => { ev.stopPropagation(); renameStart(d, t, s); };
    const here = normDir(s.cwd) === normDir(cwdEl.value);
    const meta = el('div', 'd');
    meta.append(el('span', here ? 'sf here' : 'sf', s.cwd ? dirLeaf(s.cwd) : '?'), el('span', '', ` · ${ago(s.lastModified)}`));
    if (s.gitBranch && s.gitBranch !== 'HEAD') meta.append(el('span', 'sb', `⎇ ${s.gitBranch}`));
    d.title = `${s.cwd || ''}${s.gitBranch ? `  ⎇ ${s.gitBranch}` : ''}${s.exists ? '' : '\n(フォルダが見つかりません)'}`;
    const del = el('span', 'ed del', '🗑'); del.title = '会話を削除';
    del.onclick = (ev) => { ev.stopPropagation(); deleteSessionUi(s); };
    d.append(t, meta, ed, del);
    d.onclick = () => openSession(s);
    box.append(d);
  }
}
$('#sessq').addEventListener('input', renderSessions);
// 会話の履歴の削除。Claude Code 本体の履歴からも消え、元に戻せない。確認ダイアログの既定はキャンセル
async function deleteSessionUi(s) {
  if (busy && s.sessionId === currentSession) { toast('応答中の会話は削除できません。止めてからにしてください'); return; }
  const title = splitAttachments(s.title).text.trim() || s.title;
  const body = el('div'); body.append(el('div', '', `「${title.length > 60 ? `${title.slice(0, 60)}…` : title}」`), el('div', 'note', `${s.cwd || ''}${s.gitBranch ? `  ⎇ ${s.gitBranch}` : ''}`),
    el('div', '', 'この会話の履歴を削除します。Claude Code 本体 (ターミナル) の履歴からも消え、元に戻せません。'));
  const c = await askChoice({ title: '会話を削除しますか？', body, buttons: [{ label: 'キャンセル', value: 'cancel', def: true }, { label: '削除する', value: 'delete', danger: true }] });
  if (c !== 'delete') return;
  try {
    await postJson('/api/session/delete', { id: s.sessionId, dir: s.cwd || '' });
    sessAll = sessAll.filter((x) => x.sessionId !== s.sessionId);
    if (s.sessionId === currentSession) { ws.send(JSON.stringify({ type: 'newSession' })); currentSession = null; sessionLabel = ''; statusEl.textContent = ''; clearChat(); }
    renderSessions(); toast('会話を削除しました');
  } catch (e) { toast(`削除できませんでした: ${e.message}`); }
}
function renameStart(row, titleEl, s) {
  const inp = el('input', 'rn'); inp.value = splitAttachments(s.title).text.trim() || s.title; titleEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (save && v && v !== (splitAttachments(s.title).text.trim() || s.title)) {
      try {
        const r = await fetch(`/api/rename?${new URLSearchParams({ cwd: cwdEl.value.trim() })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: s.cwd, id: s.sessionId, title: v }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      } catch (e) { add(el('div', 'err-box', '名前を変更できませんでした: ' + e.message)); }
    }
    loadSessions();
  };
  inp.onclick = (ev) => ev.stopPropagation();
  inp.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) finish(true); else if (ev.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
}
async function openSession(s) {
  if (busy) return;
  const id = s.sessionId;
  if (!s.exists) { toast(`この会話のフォルダが見つかりません: ${s.cwd || '(不明)'}`); return; }
  if (s.cwd && normDir(s.cwd) !== normDir(cwdEl.value)) { if (!(await switchCwd(s.cwd))) { toast('作業フォルダを切り替えられませんでした'); return; } } // 会話のフォルダへ戻る
  if (s.gitBranch && s.gitBranch !== 'HEAD') { // 会話のブランチへ戻るか尋ねる (違うときだけ)
    let g = null; try { g = await api('/api/git/status', {}); } catch { /* Git でなければ無視 */ }
    if (g && g.repo && g.branch && g.branch !== s.gitBranch) {
      const c = await askChoice({ title: 'ブランチが違います', body: `この会話は、ブランチ「${s.gitBranch}」で行われました。いまは「${g.branch}」です。`, buttons: [
        { label: 'キャンセル', value: 'cancel' }, { label: 'このまま開く', value: 'keep', def: true }, { label: `「${s.gitBranch}」に切り替える`, value: 'switch', primary: true }] });
      if (c === null || c === 'cancel') return;
      if (c === 'switch') { try { await postJson('/api/git/switch', { branch: s.gitBranch }); loadGit(); } catch (e) { toast(`ブランチを切り替えられませんでした: ${e.message}`); } }
    }
  }
  try {
    const msgs = await api('/api/session', { id, dir: s.cwd || '' });
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
// ---------- ファイルツリー: 自動更新 / ドラッグで移動 / 元に戻す ----------
const openDirs = new Set(); // 開いているフォルダ (更新しても開いたままにする)
const MOVE_TYPE = 'application/x-cdock-move';
let treeBusy = false, treeAgain = false;

async function fillDir(container, rel, depth) {
  let data;
  try { data = await api('/api/tree', { dir: rel }); }
  catch (e) { if (rel !== '.') openDirs.delete(rel); container.replaceChildren(el('div', 'hint', e.message)); return; }
  if (rel === '.') treeRoot = data.root || treeRoot;
  const holder = document.createElement('div'); const pending = []; // 裏で組み立ててから、一度に差し替える (ちらつき防止)
  if (!data.entries.length) holder.append(el('div', 'hint', '(空)'));
  for (const ent of data.entries) {
    const childRel = rel === '.' ? ent.name : `${rel}/${ent.name}`;
    const row = el('div', `row ${ent.dir ? 'dir' : 'file'}${previewRel === childRel ? ' sel' : ''}${treeSelRel === childRel ? ' picked' : ''}`); row.style.paddingLeft = `${6 + depth * 18}px`;
    row.append(el('span', 'ch', ent.dir ? '▸' : ''), el('span', '', ent.name)); row.title = childRel;
    moveSource(row, childRel, !ent.dir);
    row.oncontextmenu = (ev) => { ev.preventDefault(); pickRow(row, childRel); showCtx(ev.clientX, ev.clientY, childRel, ent.dir, row); };
    holder.append(row);
    if (ent.dir) {
      const sub = el('div'); sub.hidden = true; holder.append(sub); let loaded = false;
      const setOpen = async (open) => {
        sub.hidden = !open; row.querySelector('.ch').textContent = open ? '▾' : '▸';
        if (open) openDirs.add(childRel); else openDirs.delete(childRel);
        if (open && !loaded) { loaded = true; await fillDir(sub, childRel, depth + 1); }
      };
      row.onclick = () => { pickRow(row, childRel); setOpen(sub.hidden); };
      dropTarget(row, childRel);
      if (openDirs.has(childRel)) { sub.hidden = false; row.querySelector('.ch').textContent = '▾'; loaded = true; pending.push(fillDir(sub, childRel, depth + 1)); }
    } else {
      const at = el('span', 'at', '＠'); at.title = '入力欄に @パス を挿入';
      at.onclick = (ev) => { ev.stopPropagation(); insertAtCursor(atRef(childRel)); };
      row.append(at);
      row.onclick = () => { pickRow(row, childRel); openPreview(childRel, row); };
      row.ondblclick = () => insertAtCursor(atRef(childRel));
      row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(MOVE_TYPE)) e.stopPropagation(); }); // ファイルの上は移動先にならない
    }
  }
  await Promise.all(pending);
  container.replaceChildren(...holder.childNodes);
}
async function refreshTree() {
  if (treeBusy) { treeAgain = true; return; }
  treeBusy = true; const pane = $('#pane-files'); const top = pane.scrollTop;
  try { await fillDir($('#tree'), '.', 0); } finally { treeBusy = false; }
  pane.scrollTop = top;
  if (treeAgain) { treeAgain = false; refreshTree(); }
}
function loadRoot(keep) { if (!keep) openDirs.clear(); return refreshTree(); }
dropTarget($('#tree'), '.'); // ツリーの空いている場所へドロップ = 最上位のフォルダへ移動

// ファイル / フォルダを、ドラッグで別のフォルダへ移動する (ファイルは、会話欄へのドロップで添付にもなる)
function moveSource(node, rel, isFile) {
  node.draggable = true;
  node.ondragstart = (ev) => {
    ev.dataTransfer.setData(MOVE_TYPE, rel);
    const ref = isFile ? rel : `${rel}/`; // フォルダは末尾に / を付けて、会話欄へのドロップでディレクトリの添付になる
    ev.dataTransfer.setData(REF_TYPE, ref); ev.dataTransfer.setData('text/plain', `${atRef(ref)} `);
    ev.dataTransfer.effectAllowed = 'copyMove';
  };
}
function dropTarget(node, destRel) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(MOVE_TYPE)) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; node.classList.add('drop-target'); $('#dropzone').hidden = true;
  });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    const from = e.dataTransfer.getData(MOVE_TYPE); if (!from) return;
    e.preventDefault(); e.stopPropagation(); node.classList.remove('drop-target'); dragEnd(); doMove(from, destRel);
  });
}
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
// 移動したパスを、開いているプレビュー・添付・開いているフォルダにも反映する
function remapPaths(oldRel, newRel) {
  const remap = (p) => (p === oldRel ? newRel : p.startsWith(`${oldRel}/`) ? newRel + p.slice(oldRel.length) : p);
  const opened = [...openDirs].map(remap); openDirs.clear(); opened.forEach((p) => openDirs.add(p));
  for (const a of attachments) if (a.rel) { const n = remap(a.rel); if (n !== a.rel) { a.rel = n; a.name = n.slice(n.lastIndexOf('/') + 1); a.sub = parentOf(n) || 'プロジェクト内'; } }
  renderAttach();
  if (gitSel) gitSel = remap(gitSel);
  if (previewRel) { const n = remap(previewRel); if (n !== previewRel) openPreview(n); }
}
// 一時的なお知らせ (画面左下)。ボタンを付けられる
let toastTimer = null;
function toast(text, opt = {}) {
  let t = $('#toast'); if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.append(t); }
  clearTimeout(toastTimer); t.textContent = ''; t.className = `toast${opt.bad ? ' bad' : ''}`;
  t.append(el('span', 'tt', text));
  if (opt.label) { const b = el('button', '', opt.label); b.type = 'button'; b.onclick = () => { t.remove(); opt.act(); }; t.append(b); }
  const x = el('button', 'tx', '✕'); x.type = 'button'; x.title = '閉じる'; x.onclick = () => t.remove(); t.append(x);
  toastTimer = setTimeout(() => t.remove(), opt.bad ? 12000 : 10000);
}

// ---------- 確認ダイアログ (選択肢つき)。Esc で null、Enter で既定のボタン ----------
function askChoice({ title, body, buttons }) {
  return new Promise((resolve) => {
    const box = el('div', 'dlg'); const card = el('div', 'dlg-card small'); card.setAttribute('role', 'dialog');
    card.append(el('div', 'dlg-head', title));
    const msg = el('div', 'dlg-msg'); if (typeof body === 'string') msg.textContent = body; else msg.append(body); card.append(msg);
    const foot = el('div', 'dlg-foot dlg-choices'); let def = null;
    const done = (v) => { box.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    for (const b of buttons) {
      const btn = el('button', b.danger ? 'danger' : b.primary ? 'send' : 'ghost', b.label); btn.type = 'button'; btn.onclick = () => done(b.value);
      if (b.def) def = btn; foot.append(btn);
    }
    card.append(foot); box.append(card);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); (document.activeElement && foot.contains(document.activeElement) ? document.activeElement : def)?.click(); }
    };
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('mousedown', (e) => { if (e.target === box) done(null); });
    document.body.append(box); (def || foot.lastChild).focus();
  });
}
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
async function postJson(path, body) {
  const r = await fetch(`${path}?${new URLSearchParams({ cwd: cwdEl.value.trim() })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error || `エラー ${r.status}`), { code: j.code, info: j.info });
  return j;
}

// ---------- 移動 (同名があるときは選ぶ) / 元に戻す ----------
const fsMovePost = (from, toDir, opt = {}) => postJson('/api/fs/move', { from, toDir, ...opt });
async function doMove(from, destRel, opt) {
  const toDir = destRel === '.' ? '' : destRel;
  if (parentOf(from) === toDir) return; // すでにそのフォルダ: 何もしない
  try {
    const j = await fsMovePost(from, toDir, opt);
    remapPaths(j.from, j.to); if (toDir) openDirs.add(toDir);
    toast(`移動しました: ${j.from} → ${toDir || '(最上位)'}${j.to !== (toDir ? `${toDir}/` : '') + baseName(j.from) ? ` (${baseName(j.to)} に改名)` : ''}`, { label: '元に戻す', act: () => undoMove(j) });
    refreshTree(); loadGit(); invalidateIndex();
  } catch (e) {
    if (e.code === 'exists' && !opt) {
      const what = (d) => (d ? 'フォルダ' : 'ファイル');
      const choice = await askChoice({
        title: '同じ名前のものがあります',
        body: `移動先に、同じ名前の${what(e.info.destIsDir)}「${e.info.name}」があります。どうしますか？`,
        buttons: [
          { label: '両方残す (名前を変えて移動)', value: 'rename', primary: true },
          { label: '置き換える (元のものはごみ箱へ)', value: 'overwrite', danger: true },
          { label: 'キャンセル', value: null, def: true },
        ],
      });
      if (choice) doMove(from, destRel, { onConflict: choice });
      return;
    }
    toast(e.message, { bad: true });
  }
}
async function undoMove(j) {
  try {
    const back = await fsMovePost(j.to, parentOf(j.from), { name: baseName(j.from) }); // 改名していても、元の名前で戻す
    remapPaths(back.from, back.to);
    if (j.replacedId) await postJson('/api/trash/restore', { id: j.replacedId }); // 置き換えられたものも、ごみ箱から戻す
    toast(`元に戻しました: ${back.to}${j.replacedId ? ' (置き換えられたものも復元)' : ''}`); refreshTree(); loadGit(); invalidateIndex();
  } catch (e) { toast(`元に戻せませんでした: ${e.message}`, { bad: true }); }
}

// ---------- 削除 (Rogue のごみ箱へ。30 日保管) ----------
function forgetPath(rel) {
  const hit = (p) => p === rel || p.startsWith(`${rel}/`);
  attachments = attachments.filter((a) => !(a.rel && hit(a.rel))); renderAttach();
  [...openDirs].filter(hit).forEach((p) => openDirs.delete(p));
  if (previewRel && hit(previewRel)) { pv.box.hidden = true; previewRel = null; }
  if (gitSel && hit(gitSel)) gitSel = null;
  if (treeSelRel && hit(treeSelRel)) treeSelRel = null;
}
async function restoreItems(items) {
  let renamed = 0; let failedMsg = '';
  for (const it of items) { try { const r = await postJson('/api/trash/restore', { id: it.id }); if (r.renamed) renamed++; } catch (e) { failedMsg = e.message; } }
  if (failedMsg) toast(`元に戻せませんでした: ${failedMsg}`, { bad: true });
  else toast(`元に戻しました${renamed ? ` (同名があったため ${renamed} 件は名前を変えて復元)` : ''}`);
  refreshTree(); loadGit(); invalidateIndex();
}
async function deleteRels(rels) {
  if (!rels.length) return;
  if (!serverFeatures.has('trash')) { toast('サーバーが古いため、削除できません。start.cmd で起動し直してください。', { bad: true }); return; }
  const list = el('div'); list.append(el('div', '', `${rels.length === 1 ? '次のものを' : `${rels.length} 件を`}ごみ箱へ移動します。`));
  const ul = el('ul', 'dlg-list2'); for (const r of rels.slice(0, 6)) ul.append(el('li', '', r)); if (rels.length > 6) ul.append(el('li', '', `ほか ${rels.length - 6} 件`)); list.append(ul);
  list.append(el('div', 'dlg-sub', 'フォルダは、中身ごと移動します。「ファイル」タブのごみ箱ボタンか、お知らせの「元に戻す」で戻せます (30 日保管)。'));
  const ok = await askChoice({ title: 'ごみ箱へ移動しますか？', body: list, buttons: [{ label: 'ごみ箱へ移動', value: true, danger: true }, { label: 'キャンセル', value: false, def: true }] });
  if (!ok) return;
  try {
    const j = await postJson('/api/fs/delete', { paths: rels });
    for (const it of j.items) forgetPath(it.rel);
    if (j.items.length) toast(`ごみ箱へ移動しました: ${baseName(j.items[0].rel)}${j.items.length > 1 ? ` ほか ${j.items.length - 1} 件` : ''}`, { label: '元に戻す', act: () => restoreItems(j.items) });
    if (j.failed.length) toast(`${j.failed.length} 件は移動できませんでした: ${j.failed[0].error}`, { bad: true });
    refreshTree(); loadGit(); invalidateIndex();
  } catch (e) { toast(e.message, { bad: true }); }
}
// 選択した行 (ファイルツリーで、最後にクリックしたもの)。Delete キーと右クリックメニューの対象
let treeSelRel = null;
function pickRow(row, rel) { document.querySelectorAll('#tree .row.picked').forEach((r) => r.classList.remove('picked')); row.classList.add('picked'); treeSelRel = rel; }
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' || e.ctrlKey || e.altKey || e.metaKey || !treeSelRel || $('#pane-files').hidden) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.querySelector('.dlg:not([hidden])')) return;
  e.preventDefault(); deleteRels([treeSelRel]);
});
// 右クリックメニュー
function closeCtx() { $('#ctxmenu')?.remove(); }
function showCtx(x, y, rel, isDir, row) {
  closeCtx(); const m = el('div', 'ctxmenu'); m.id = 'ctxmenu';
  const item = (label, act, cls) => { const b = el('div', `ci ${cls || ''}`, label); b.onclick = () => { closeCtx(); act(); }; m.append(b); };
  if (isDir) { item('開く / 閉じる', () => row.click()); item('このフォルダを作業フォルダにする', () => switchCwd(absPath(rel))); item('＠ 入力欄に挿入', () => insertAtCursor(atRef(`${rel}/`))); item('会話に添付する (フォルダ)', () => addRef(`${rel}/`)); }
  else { item('プレビュー', () => openPreview(rel, row)); item('＠ 入力欄に挿入', () => insertAtCursor(atRef(rel))); item('添付する', () => addRef(rel)); }
  item('パスをコピー', async () => { try { await navigator.clipboard.writeText(rel); toast(`コピーしました: ${rel}`); } catch { toast('コピーできませんでした', { bad: true }); } });
  m.append(el('div', 'csep')); item('ごみ箱へ移動…', () => deleteRels([rel]), 'danger');
  document.body.append(m);
  const r = m.getBoundingClientRect(); m.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`; m.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest || !e.target.closest('#ctxmenu')) closeCtx(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
window.addEventListener('blur', closeCtx);
$('#pane-files').addEventListener('scroll', closeCtx);

// ---------- ごみ箱の画面 (復元 / 完全に削除 / 空にする) ----------
async function openTrash() {
  let items; try { items = await api('/api/trash', {}); } catch (e) { toast(e.message, { bad: true }); return; }
  const box = el('div', 'dlg'); const card = el('div', 'dlg-card trash'); card.setAttribute('role', 'dialog');
  const head = el('div', 'dlg-head'); head.append(el('span', '', 'ごみ箱 (Rogue)')); const x = el('button', 'ghost', '✕'); x.type = 'button'; head.append(x); card.append(head);
  card.append(el('div', 'dlg-sub trash-note', '消したファイルは 30 日間ここに保管されます。このフォルダにあったものだけ、ここから復元できます。'));
  const list = el('div', 'dlg-list trash-list'); card.append(list);
  const foot = el('div', 'dlg-foot'); const cnt = el('span', 'dlg-cur', ''); const emptyBtn = el('button', 'danger', 'ごみ箱を空にする'); emptyBtn.type = 'button'; const closeBtn = el('button', 'ghost', '閉じる'); closeBtn.type = 'button';
  foot.append(cnt, emptyBtn, closeBtn); card.append(foot); box.append(card);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.dlg + .dlg')) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true); x.onclick = close; closeBtn.onclick = close; box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
  const render = () => {
    list.textContent = ''; cnt.textContent = `${items.length} 件`; emptyBtn.disabled = !items.length;
    if (!items.length) list.append(el('div', 'hint', 'ごみ箱は空です'));
    for (const it of items) {
      const row = el('div', 'trow'); const info = el('div', 'tinfo');
      info.append(el('div', 'tname', `${it.isDir ? '📁 ' : ''}${it.name}`), el('div', 'tpath', `${it.rel ?? it.orig} · ${ago(it.deletedAt)}`));
      const rb = el('button', 'ghost', '復元'); rb.type = 'button'; rb.disabled = !it.here; rb.title = it.here ? '元の場所へ戻します' : 'このフォルダの外にあったものは、ここからは復元できません';
      rb.onclick = async () => { try { const r = await postJson('/api/trash/restore', { id: it.id }); items = items.filter((z) => z.id !== it.id); render(); toast(`復元しました: ${r.path}${r.renamed ? ' (同名があったため名前を変更)' : ''}`); refreshTree(); loadGit(); invalidateIndex(); } catch (e) { toast(e.message, { bad: true }); } };
      const db = el('button', 'danger', '完全に削除'); db.type = 'button';
      db.onclick = async () => {
        const ok = await askChoice({ title: '完全に削除しますか？', body: `「${it.name}」を完全に削除します。この操作は取り消せません。`, buttons: [{ label: '完全に削除', value: true, danger: true }, { label: 'キャンセル', value: false, def: true }] });
        if (ok) { try { await postJson('/api/trash/purge', { id: it.id }); items = items.filter((z) => z.id !== it.id); render(); } catch (e) { toast(e.message, { bad: true }); } }
      };
      row.append(info, rb, db); list.append(row);
    }
  };
  emptyBtn.onclick = async () => {
    const ok = await askChoice({ title: 'ごみ箱を空にしますか？', body: `${items.length} 件を完全に削除します (ほかのフォルダのものも含みます)。この操作は取り消せません。`, buttons: [{ label: '空にする', value: true, danger: true }, { label: 'キャンセル', value: false, def: true }] });
    if (ok) { try { await postJson('/api/trash/empty', {}); items = []; render(); } catch (e) { toast(e.message, { bad: true }); } }
  };
  render(); document.body.append(box); closeBtn.focus();
}
$('#trashbtn').onclick = openTrash;

// フォルダの変化 (自作のファイル・移動・削除・外部の git 操作) をサーバーから受け取って、画面を更新する
let fsTimer = null, diffState = null;
function watchCwd() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'watch', cwd: cwdEl.value.trim() })); }
function onFsChange(m) {
  clearTimeout(fsTimer);
  fsTimer = setTimeout(async () => {
    invalidateIndex();
    if (!m.dirs || m.dirs.some((d) => d === '' || openDirs.has(d))) refreshTree(); // 見えているフォルダに変化があるときだけ
    loadGit();
    if (fsearch_active()) runSearch();
    if (editState && (m.files || []).includes(editState.rel)) onEditedFileChange();
    else if (previewRel && (m.files || []).includes(previewRel)) { const top = pv.body.scrollTop; await openPreview(previewRel); pv.body.scrollTop = top; }
    else if (diffState && m.git && !editState) { const top = pv.body.scrollTop; await openDiff(diffState.rel, diffState.untracked); pv.body.scrollTop = top; }
  }, 150);
}
const fsearch_active = () => !$('#fresults').hidden && !!$('#fsearch').value.trim();
let focusAt = 0;
window.addEventListener('focus', () => { if (Date.now() - focusAt < 1500) return; focusAt = Date.now(); invalidateIndex(); refreshTree(); loadGit(); }); // 取りこぼしの保険

// ---------- プレビュー ----------
let previewRel = null;
const pv = { box: $('#preview'), name: $('#pname'), body: $('#pbody') };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const rawUrl = (rel) => `/api/raw?${new URLSearchParams({ cwd: cwdEl.value.trim(), path: rel })}`;
// Markdown: 表示 / ソースの切り替え、相対リンク (他のファイル) と相対パスの画像
let mdState = null, mdRaw = false;
function resolveRel(base, url) {
  const clean = url.split('#')[0].split('?')[0]; if (!clean) return null;
  let target; try { target = decodeURIComponent(clean); } catch { return null; }
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
// Mermaid (```mermaid のコードブロックを図にする)。Markdown のプレビューで、初めて必要になったときだけ読み込む
let mermaidP = null, mermaidSeq = 0;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidP) return mermaidP;
  mermaidP = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/mermaid/mermaid.min.js';
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid を初期化できませんでした')));
    s.onerror = () => reject(new Error('Mermaid を読み込めませんでした'));
    document.head.append(s);
  });
  mermaidP.catch(() => { mermaidP = null; });
  return mermaidP;
}
async function renderMermaid(root) {
  const blocks = [...root.querySelectorAll('pre[data-lang="mermaid"]')]; if (!blocks.length) return;
  let m; try { m = await loadMermaid(); } catch (e) { for (const b of blocks) b.before(el('div', 'note', e.message)); return; }
  m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDarkTheme() ? 'dark' : 'default', fontFamily: 'system-ui, "Segoe UI", sans-serif' });
  for (const pre of blocks) {
    const id = `mmd${++mermaidSeq}`;
    try {
      const { svg } = await m.render(id, pre.textContent);
      const box = el('div', 'mermaid'); box.innerHTML = svg; pre.replaceWith(box); // securityLevel strict: Mermaid が出力を無害化する
    } catch (e) {
      document.getElementById(`d${id}`)?.remove(); // 失敗時に Mermaid が body に残す要素
      pre.before(el('div', 'note mmerr', `Mermaid の図を描画できませんでした: ${String((e && e.message) || e).split('\n')[0]}`));
    }
  }
}
function renderMdPreview() {
  const { rel, d } = mdState; pv.body.textContent = '';
  if (d.truncated) pv.body.append(el('div', 'note', `先頭 1MB のみ表示 (${fmtSize(d.size)})`));
  if (mdRaw) pv.body.append(el('pre', 'code', d.text));
  else { const div = el('div', 'md doc'); div.innerHTML = md(d.text, { soft: true, resolve: (u) => resolveRel(rel, u), rawUrl }); pv.body.append(div); renderMermaid(div); }
  $('#pmode').textContent = mdRaw ? '表示' : 'ソース';
}
$('#pmode').onclick = () => { if (!mdState) return; mdRaw = !mdRaw; renderMdPreview(); };
pv.body.addEventListener('click', (e) => { const a = e.target.closest('a[data-rel]'); if (a) { e.preventDefault(); openPreview(a.dataset.rel); } });

// PowerPoint: スライド画像 (PowerPoint がある Windows のみ) / テキスト の切り替え
function pptxTextView(d) {
  const box = el('div');
  box.append(el('div', 'note', `${d.slides.length} スライド (テキストのみ。画像・図形は表示されません)`));
  for (const sl of d.slides) {
    const c = el('div', 'slide'); c.append(el('h4', '', `SLIDE ${sl.n}`));
    sl.lines.forEach((t, i) => c.append(el('div', i === 0 ? 'l1' : 'ln', t)));
    if (!sl.lines.length) c.append(el('div', 'ln note', '(テキストなし)'));
    box.append(c);
  }
  return box;
}
function renderPptx(rel, d) {
  const wrap = el('div', 'pptx'); const bar = el('div', 'pptbar');
  const bSlides = el('button', 'ghost', 'スライド'), bText = el('button', 'ghost', 'テキスト'); bSlides.type = bText.type = 'button';
  bar.append(bSlides, bText);
  const status = el('div', 'note'); const imgs = el('div', 'slides'); const text = pptxTextView(d);
  wrap.append(bar, status, imgs, text); pv.body.append(wrap);
  const show = (m) => {
    imgs.hidden = m !== 'slides'; text.hidden = m !== 'text'; status.hidden = m !== 'slides' || !status.textContent;
    bSlides.classList.toggle('on', m === 'slides'); bText.classList.toggle('on', m === 'text');
  };
  let started = false;
  async function poll() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let k = 0; k < 120; k++) {
      if (previewRel !== rel) return;
      let s; try { s = await api('/api/slides', { path: rel }); } catch (e) { status.textContent = e.message; started = false; show('slides'); return; }
      if (!s.available) { status.textContent = ''; bSlides.disabled = true; bSlides.title = 'PowerPoint が見つからないため、スライド画像は表示できません'; show('text'); return; }
      if (s.status === 'ready') {
        status.textContent = ''; imgs.textContent = '';
        for (let n = 1; n <= s.count; n++) {
          const fig = el('figure', 'slide-fig'); const im = el('img'); im.loading = 'lazy'; im.alt = `スライド ${n}`;
          im.src = `/api/slide?${new URLSearchParams({ cwd: cwdEl.value.trim(), path: rel, n: String(n), k: s.key })}`;
          fig.append(im, el('figcaption', '', `SLIDE ${n} / ${s.count}`)); imgs.append(fig);
        }
        show('slides'); return;
      }
      if (s.status === 'error') { status.textContent = `スライド画像を作れませんでした: ${s.error || ''}`; started = false; show('slides'); return; }
      status.textContent = 'スライド画像を作成中… (PowerPoint を裏で動かしています。初回は数秒〜数十秒かかります)'; show('slides');
      await wait(1500);
    }
    status.textContent = '時間がかかっています。しばらくしてから、もう一度開いてください'; started = false; show('slides');
  }
  const startSlides = () => { if (!started) { started = true; poll(); } };
  bText.onclick = () => show('text');
  bSlides.onclick = () => { show('slides'); startSlides(); };
  show('slides'); startSlides(); // 既定はスライド。PowerPoint が無ければ自動でテキストに戻る
}

async function openPreview(rel, row, line) {
  if (editState && !(await confirmLeaveEdit())) return;
  $('#pmode').hidden = true; $('#pedit').hidden = true; mdState = null; diffState = null; curDoc = null; disposeDiffEditor();
  document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel')); row?.classList.add('sel');
  previewRel = rel; pv.box.hidden = false; pv.name.textContent = line ? `${rel}:${line}` : rel; pv.body.textContent = '読み込み中…';
  let d; try { d = await api('/api/file', { path: rel }); } catch (e) { pv.body.textContent = ''; pv.body.append(el('div', 'note', e.message)); return; }
  if (previewRel !== rel) return;
  pv.body.textContent = ''; pv.body.scrollTop = 0;
  if (d.kind === 'text' || d.kind === 'markdown') { curDoc = { rel, d }; $('#pedit').hidden = !d.editable; }
  if ((d.kind === 'text' || d.kind === 'markdown') && line) {
    // 検索結果から開いたときは、行番号つきで表示して該当行を強調する
    const box = el('div', 'code lines');
    d.text.split(NL).forEach((t, i) => { const r = el('div', `cl${i + 1 === line ? ' hit' : ''}`); r.append(el('span', 'no', String(i + 1)), el('span', 'tx', t)); box.append(r); });
    pv.body.append(box); box.querySelector('.hit')?.scrollIntoView({ block: 'center' });
  } else if (d.kind === 'text') {
    if (d.truncated) pv.body.append(el('div', 'note', `先頭 1MB のみ表示 (${fmtSize(d.size)})`));
    pv.body.append(el('pre', 'code', d.text));
  } else if (d.kind === 'markdown') {
    mdState = { rel, d }; mdRaw = false; $('#pmode').hidden = false; renderMdPreview();
  } else if (d.kind === 'image') {
    const img = el('img'); img.alt = d.name; img.src = rawUrl(rel); pv.body.append(img);
  } else if (d.kind === 'pdf') {
    const f = el('iframe'); f.src = rawUrl(rel); pv.body.append(f);
  } else if (d.kind === 'pptx') {
    renderPptx(rel, d);
  } else if (d.kind === 'docx') {
    pv.body.append(el('div', 'note', 'Word · テキストのみ'));
    for (const t of d.lines) pv.body.append(el('p', '', t));
  } else {
    pv.body.append(el('div', 'note', `${d.name} (${fmtSize(d.size)}) — ${d.note || 'プレビューできない形式です'}`));
  }
}
$('#pclose').onclick = async () => { if (!(await confirmLeaveEdit())) return; disposeDiffEditor(); pv.box.hidden = true; curDoc = null; previewRel = null; document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel')); };
$('#pinsert').onclick = () => { if (previewRel) insertAtCursor(atRef(previewRel)); };


// ---------- 編集 (Monaco)。小さな修正・文書の手直し用。補完・デバッグなど IDE の機能は持たない ----------
let curDoc = null;   // いま開いているテキスト / Markdown { rel, d }
let editState = null; // 編集中 { rel, d, editor, model, mtimeMs, cleanVer, ignoreMtime, banner }
let monacoP = null;
function loadMonaco() {
  if (monacoP) return monacoP;
  monacoP = new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = '/vendor/monaco/vs/loader.js';
    s.onerror = () => reject(new Error('エディタ (Monaco) を読み込めませんでした'));
    s.onload = () => {
      const V = '/vendor/monaco/vs/';
      window.MonacoEnvironment = { getWorkerUrl: (_, label) => V + ({ json: 'language/json/json.worker.js', css: 'language/css/css.worker.js', scss: 'language/css/css.worker.js', less: 'language/css/css.worker.js', html: 'language/html/html.worker.js', handlebars: 'language/html/html.worker.js', razor: 'language/html/html.worker.js', typescript: 'language/typescript/ts.worker.js', javascript: 'language/typescript/ts.worker.js' }[label] || 'editor/editor.worker.js') };
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        const m = window.monaco;
        // 構文チェック・補完は使わない (非目標)。エラー波線が出ると、ただの文書にも赤線が付くため
        try { m.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }); } catch { /* 無視 */ }
        try { m.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }); } catch { /* 無視 */ }
        try { m.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false }); } catch { /* 無視 */ }
        try { m.languages.css.cssDefaults.setOptions({ validate: false }); } catch { /* 無視 */ }
        resolve(m);
      }, reject);
    };
    document.head.append(s);
  });
  monacoP.catch(() => { monacoP = null; });
  return monacoP;
}
const cssVar = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
const isDarkTheme = () => { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
function applyMonacoLook(editor) {
  const m = window.monaco; const dark = isDarkTheme();
  m.editor.defineTheme('cdock', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: {
    'editor.background': cssVar('--panel', dark ? '#30302e' : '#ffffff'), 'editor.foreground': cssVar('--text', dark ? '#ece9df' : '#3d3929'),
    'editorLineNumber.foreground': cssVar('--muted', '#8c8878'), 'editorGutter.background': cssVar('--panel', '#ffffff'),
  } });
  m.editor.setTheme('cdock');
  editor.updateOptions({ fontSize: Math.max(10, (parseFloat(cssVar('--fs', '14')) || 14) - 1.5), fontFamily: cssVar('--mono', 'Consolas, monospace') });
}
function syncEditorTheme() { if (!window.monaco) return; if (editState) applyMonacoLook(editState.editor); else if (diffEd) applyMonacoLook(diffEd.editor); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncEditorTheme());
const editDirty = () => !!editState && editState.model.getAlternativeVersionId() !== editState.cleanVer;
function editMarks() {
  if (!editState) return; const dirty = editDirty();
  pv.name.textContent = `${dirty ? '● ' : ''}${editState.rel}`; pv.name.title = dirty ? '未保存の変更があります' : '';
  const b = $('#psave'); b.disabled = !dirty; b.classList.toggle('send', dirty); b.classList.toggle('ghost', !dirty); b.classList.toggle('saved', !dirty);
  b.textContent = editState.saving ? '保存中…' : dirty ? '保存' : '✓ 保存済み';
}
function editBanner(text, buttons) {
  const b = editState?.banner; if (!b) return; b.textContent = ''; b.hidden = !text; if (!text) return;
  b.append(el('span', '', text));
  for (const [label, fn] of buttons || []) { const x = el('button', 'ghost mini', label); x.type = 'button'; x.onclick = fn; b.append(x); }
}
async function startEdit() {
  if (!curDoc || editState || !curDoc.d.editable) return;
  const { rel, d } = curDoc; let m;
  try { pv.body.textContent = ''; pv.body.append(el('div', 'note', 'エディタを読み込み中…')); m = await loadMonaco(); } catch (e) { toast(e.message); await openPreview(rel); return; }
  if (previewRel !== rel || editState) return;
  pv.body.textContent = ''; pv.body.classList.add('editing');
  const banner = el('div', 'edbanner'); banner.hidden = true; const host = el('div', 'edhost'); pv.body.append(banner, host);
  const model = m.editor.createModel(d.text, undefined, m.Uri.parse(`inmemory://cdock/${encodeURI(rel)}`));
  const wrap = /\.(md|markdown|txt|text|rst)$/i.test(rel);
  const editor = m.editor.create(host, {
    model, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: wrap ? 'on' : 'off', renderWhitespace: 'none',
    quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: 'off', parameterHints: { enabled: false }, hover: { enabled: false },
    lightbulb: { enabled: 'off' }, codeLens: false, occurrencesHighlight: 'off', 'semanticHighlighting.enabled': false, inlineSuggest: { enabled: false },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false }, links: false, colorDecorators: false,
    acceptSuggestionOnEnter: 'off', tabCompletion: 'off', folding: !wrap, glyphMargin: false, lineNumbersMinChars: 3, padding: { top: 8, bottom: 8 },
  });
  editState = { rel, d, editor, model, mtimeMs: d.mtimeMs, cleanVer: model.getAlternativeVersionId(), ignoreMtime: null, banner };
  editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => { saveEdit(); });
  model.onDidChangeContent(editMarks);
  syncEditorTheme(); editMarks();
  $('#pedit').hidden = true; $('#pmode').hidden = true; $('#psave').hidden = false; $('#pcancel').hidden = false;
  editor.focus();
}
function exitEditUi() {
  if (!editState) return; const s = editState; editState = null;
  s.editor.dispose(); s.model.dispose(); pv.body.classList.remove('editing'); pv.body.textContent = '';
  $('#psave').hidden = true; $('#pcancel').hidden = true; pv.name.title = '';
}
// 編集中のものがあれば、保存・破棄・キャンセルを尋ねる。続けてよければ true
async function confirmLeaveEdit() {
  if (!editState) return true;
  if (editDirty()) {
    const c = await askChoice({ title: '保存していない変更があります', body: `${editState.rel} の変更を、どうしますか？`, buttons: [
      { label: 'キャンセル', value: 'cancel', def: true }, { label: '破棄して続ける', value: 'discard', danger: true }, { label: '保存して続ける', value: 'save', primary: true }] });
    if (c === 'save') { if (!(await saveEdit())) return false; } else if (c !== 'discard') return false;
  }
  exitEditUi(); return true;
}
async function saveEdit(opt = {}) {
  const s = editState; if (!s) return false;
  const text = s.model.getValue(); const ver = s.model.getAlternativeVersionId();
  s.saving = true; editMarks();
  try {
    const r = await postJson('/api/file/save', { path: s.rel, text, mtimeMs: s.mtimeMs, eol: s.d.eol, ...opt });
    s.mtimeMs = r.mtimeMs; s.cleanVer = ver; s.d.enc = r.enc || s.d.enc; s.d.text = text; s.saving = false; editBanner(''); editMarks(); toast('保存しました'); loadGit(); return true; // 変更タブにすぐ反映 (自動更新を待たない)
  } catch (e) {
    s.saving = false; editMarks();
    if (e.code === 'changed') {
      const c = await askChoice({ title: 'ファイルが変更されています', body: `${s.rel} は、開いたあとに別の場所 (Claude や他のツール) で変更されました。`, buttons: [
        { label: 'キャンセル', value: 'cancel', def: true }, { label: '外部の内容を読み込む (編集を破棄)', value: 'reload', danger: true }, { label: '自分の内容で上書き', value: 'force', primary: true }] });
      if (!editState || editState !== s) return false;
      if (c === 'force') return saveEdit({ ...opt, force: true });
      if (c === 'reload') await reloadExternal();
      return false;
    }
    if (e.code === 'encoding') {
      const c = await askChoice({ title: '文字コードを変換しますか？', body: `${e.message}\nUTF-8 で保存すると、他のツールで読めなくなる場合があります。`, buttons: [
        { label: 'キャンセル', value: 'cancel', def: true }, { label: 'UTF-8 に変換して保存', value: 'utf8', primary: true }] });
      if (c === 'utf8' && editState === s) return saveEdit({ ...opt, encoding: 'utf-8' });
      return false;
    }
    toast(`保存できませんでした: ${e.message}`); return false;
  }
}
// 外部で変わった内容を、エディタに読み込み直す (編集は破棄)
async function reloadExternal() {
  const s = editState; if (!s) return;
  let d; try { d = await api('/api/file', { path: s.rel }); } catch (e) { editBanner(`読み込めませんでした: ${e.message}`); return; }
  if (editState !== s) return;
  s.model.setValue(d.text); s.cleanVer = s.model.getAlternativeVersionId(); s.mtimeMs = d.mtimeMs; s.d = { ...s.d, ...d }; editBanner(''); editMarks();
}
// 編集中のファイルに、フォルダの変化が通知されたとき (自分の保存でも通知される)
async function onEditedFileChange() {
  const s = editState; if (!s) return;
  let d; try { d = await api('/api/file', { path: s.rel }); } catch { editBanner('このファイルは削除または移動されたようです。保存すると、同じ場所に作り直します', []); return; }
  if (editState !== s || d.mtimeMs === s.mtimeMs || d.mtimeMs === s.ignoreMtime) return;
  if (!editDirty()) { await reloadExternal(); toast('外部の変更を読み込みました'); return; }
  editBanner('別の場所でこのファイルが変更されました。', [['外部の内容を読み込む (編集を破棄)', () => reloadExternal()], ['無視', () => { s.ignoreMtime = d.mtimeMs; editBanner(''); }]]);
}
$('#pedit').onclick = startEdit;
$('#psave').onclick = () => { saveEdit(); };
$('#pcancel').onclick = async () => { if (!editState) return; const rel = editState.rel; if (await confirmLeaveEdit()) await openPreview(rel); };
window.addEventListener('beforeunload', (e) => { if (editDirty()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', (e) => { if (editState && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveEdit(); } });

// ---------- 実行ペイン: コマンドを1回ずつ実行して、出力を見せる。「Claude に渡す」で会話の入力欄へ ----------
const run = { id: null, text: '', cmd: '', t0: 0, timer: null, raf: 0, hist: [], hi: -1 };
try { run.hist = JSON.parse(store.get('runHist', '[]')); } catch { run.hist = []; }
const RUN_MAX = 400000;
const ANSI = new RegExp(String.fromCharCode(27) + '(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\u0007]*\\u0007)', 'g');
function runAppend(data) {
  // 色などの制御文字を除き、行頭に戻る (\r) は、その行を書き直す (進捗表示のため)
  let t = run.text; const cleaned = data.replace(ANSI, '').replace(/\r\n/g, '\n');
  for (const ch of cleaned) {
    if (ch === '\r') t = t.slice(0, t.lastIndexOf('\n') + 1); else t += ch;
  }
  run.text = t.length > RUN_MAX ? '…(先頭を省略)\n' + t.slice(t.length - RUN_MAX) : t;
  if (!run.raf) run.raf = setTimeout(() => {
    run.raf = 0; const o = $('#runout'); const near = o.scrollHeight - o.scrollTop - o.clientHeight < 40;
    o.textContent = run.text; if (near) o.scrollTop = o.scrollHeight;
  }, 50);
}
function setupShells(list) {
  const sel = $('#runshell'); sel.textContent = ''; sel.hidden = list.length < 2; if (list.length < 2) return;
  for (const o of list) { const op = el('option', '', o.label); op.value = o.id; sel.append(op); }
  const saved = store.get('runShell', list[0].id); sel.value = list.some((o) => o.id === saved) ? saved : list[0].id;
  sel.onchange = () => store.set('runShell', sel.value);
}
function runStatus(text, cls) { const s = $('#runstat'); s.textContent = text; s.className = `runstat ${cls || ''}`; }
function runUi() {
  const going = !!run.id; const b = $('#runbtn');
  b.textContent = going ? '停止' : '実行'; b.classList.toggle('send', !going); b.classList.toggle('danger', going);
  $('#runcmd').disabled = going; $('#runshell').disabled = going; runClrSync(); $('#runsend').disabled = going || !run.text; $('#runclear').disabled = going || !run.text;
}
function runStart() {
  const cmd = $('#runcmd').value.trim(); if (!cmd || run.id) return;
  if (!serverFeatures.has('run')) { runStatus('サーバーが古いため実行できません。サーバーを再起動してください', 'bad'); return; }
  if (!ws || ws.readyState !== 1) { runStatus('接続されていません', 'bad'); return; }
  run.hist = [cmd, ...run.hist.filter((h) => h !== cmd)].slice(0, 30); store.set('runHist', JSON.stringify(run.hist)); run.hi = -1;
  run.id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; run.cmd = cmd; run.text = ''; run.t0 = Date.now(); $('#runout').textContent = '';
  ws.send(JSON.stringify({ type: 'run', id: run.id, cmd, cwd: cwdEl.value.trim(), shell: $('#runshell').hidden ? undefined : $('#runshell').value }));
  clearInterval(run.timer); const tick = () => runStatus(`実行中… ${Math.round((Date.now() - run.t0) / 1000)} 秒`, 'busy'); tick(); run.timer = setInterval(tick, 500);
  runUi();
}
function runEnd(m) {
  if (m.id !== run.id) return; clearInterval(run.timer); run.id = null; const stopped = run.stopping; run.stopping = false; run.exit = stopped ? { ...m, code: null } : m;
  const sec = ((m.ms ?? (Date.now() - run.t0)) / 1000).toFixed(1);
  if (m.error) { runStatus(`✗ ${m.error}`, 'bad'); run.exit = { error: m.error }; }
  else if (m.code === 0) runStatus(`✓ 成功 (終了コード 0, ${sec} 秒)`, 'ok');
  else runStatus(stopped || m.signal ? `■ 停止しました (${sec} 秒)` : `✗ 失敗 (終了コード ${m.code}, ${sec} 秒)`, 'bad');
  if (m.error && !run.text) run.text = '';
  runUi();
}
const runClrSync = () => { $('#runclr').hidden = !$('#runcmd').value || $('#runcmd').disabled; };
$('#runcmd').addEventListener('input', runClrSync);
$('#runclr').onclick = () => { const i = $('#runcmd'); i.value = ''; run.hi = -1; runClrSync(); i.focus(); };
$('#runbtn').onclick = () => { if (run.id) run.stopping = true; if (run.id) ws.send(JSON.stringify({ type: 'run_stop', id: run.id })); else runStart(); };
$('#runcmd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runStart(); }
  else if (e.key === 'ArrowUp' && run.hist.length) { e.preventDefault(); run.hi = Math.min(run.hi + 1, run.hist.length - 1); $('#runcmd').value = run.hist[run.hi]; runClrSync(); }
  else if (e.key === 'ArrowDown' && run.hi >= 0) { e.preventDefault(); run.hi -= 1; $('#runcmd').value = run.hi >= 0 ? run.hist[run.hi] : ''; runClrSync(); }
});
$('#runclear').onclick = () => { run.text = ''; $('#runout').textContent = ''; runStatus('作業フォルダで実行します (入力待ちのコマンドは非対応)'); runUi(); };
$('#runsend').onclick = () => {
  const lines = run.text.replace(/\n+$/, '').split('\n'); const tail = lines.slice(-200);
  const x = run.exit; const result = !x ? '' : x.error ? `\n(エラー: ${x.error})` : `\n(終了コード ${x.code ?? '停止'})`;
  insertAtCursor(`\n\`\`\`\n$ ${run.cmd}\n${lines.length > tail.length ? `(先頭 ${lines.length - tail.length} 行を省略)\n` : ''}${tail.join('\n')}${result}\n\`\`\`\n`);
};

const TABS = ['sessions', 'files', 'run', 'git'];
function showTab(which) {
  for (const t of TABS) { $(`#pane-${t}`).hidden = t !== which; $(`#tab-${t}`).classList.toggle('on', t === which); }
  store.set('tab', which);
  if (which === 'git') loadGit();
  if (which === 'run') { $('#runcmd').focus(); if (ws && ws.readyState === 1 && serverFeatures.has('run')) ws.send(JSON.stringify({ type: 'run_warm' })); } // PowerShell を先に起動しておく
}
for (const t of TABS) $(`#tab-${t}`).onclick = () => showTab(t);
showTab(store.get('tab', 'sessions'));

// ---------- サイドバー: Git の変更 ----------
const GIT_LABEL = { M: '変更', A: '追加', D: '削除', R: '名前変更', C: 'コピー', U: '競合', '?': '未追跡' };
const gitState = { staged: 0, count: 0 };
let gitSel = null;
const isConflict = (xy) => xy.includes('U') || xy === 'AA' || xy === 'DD';
async function gitPost(action, body) {
  const r = await fetch(`/api/git/${action}?${new URLSearchParams({ cwd: cwdEl.value.trim() })}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || r.status);
  return j;
}
function gitMsg(text, bad) { const m = $('#commitnote'); m.textContent = text; m.classList.toggle('bad', !!bad); }
async function gitAct(action, paths) { try { await gitPost(action, { paths }); gitMsg(''); } catch (e) { gitMsg(e.message, true); } await loadGit(); }
function gitSection(list, title, files, kind) {
  if (!files.length) return;
  const head = el('div', 'gitsec');
  head.append(el('span', 'gt', `${title} (${files.length})`));
  if (kind !== 'conflict') {
    const all = el('button', 'ghost mini', kind === 'staged' ? 'すべて解除' : 'すべてステージ');
    all.onclick = () => gitAct(kind === 'staged' ? 'unstage' : 'stage', files.map((f) => f.path));
    head.append(all);
  }
  list.append(head);
  for (const f of files) {
    const row = el('div', 'gitrow' + (f.path === gitSel ? ' sel' : ''));
    const mark = kind === 'staged' ? f.xy[0] : f.xy === '??' ? '?' : (f.xy[1] !== ' ' ? f.xy[1] : f.xy[0]);
    row.title = `${GIT_LABEL[mark] || mark}: ${f.path}`;
    row.append(el('span', `gs ${mark === '?' ? 'A' : mark}`, mark), el('span', 'gp', f.path));
    if (kind !== 'conflict') {
      const btn = el('button', 'gbtn', kind === 'staged' ? '−' : '＋'); btn.title = kind === 'staged' ? 'ステージから外す' : 'ステージに追加';
      btn.onclick = (ev) => { ev.stopPropagation(); gitAct(kind === 'staged' ? 'unstage' : 'stage', [f.path]); };
      row.append(btn);
    }
    row.onclick = () => { document.querySelectorAll('.gitrow.sel').forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); gitSel = f.path; openDiff(f.path, f.xy === '??'); };
    list.append(row);
  }
}
async function loadGit() {
  const list = $('#gitlist'), br = $('#gitbranch'), badge = $('#gitcount'), box = $('#commitbox');
  let d; try { d = await api('/api/git/status', {}); } catch (e) { list.textContent = ''; list.append(el('div', 'hint', e.message)); box.hidden = true; return; }
  list.textContent = ''; badge.hidden = true;
  if (!d.repo) { br.textContent = ''; br.disabled = true; $('.repoline').hidden = true; closeBranchMenu(); box.hidden = true; list.append(el('div', 'hint', 'このフォルダは Git リポジトリではありません')); return; }
  const bname = d.branch && d.branch !== 'HEAD' ? d.branch : '(detached HEAD)';
  const BS = String.fromCharCode(92);
  const norm = (x) => String(x || '').split(BS).join('/').replace(/\/+$/, '').toLowerCase();
  const repoName = d.top && norm(d.top) !== norm(cwdEl.value) ? String(d.top).split(BS).join('/').replace(/\/+$/, '').split('/').pop() : ''; // 作業フォルダが、リポジトリの中のサブフォルダのとき
  br.textContent = `${repoName ? `${repoName} · ` : ''}⎇ ${bname}${d.files.length ? ' ●' : ''} ▾`; br.disabled = false;
  br.title = `リポジトリ: ${d.top}
ブランチ: ${bname}${d.files.length ? `
未コミットの変更: ${d.files.length} 件` : ''}
(クリックでブランチを切り替え / 新規作成)`; $('.repoline').hidden = false;
  const tracked = d.files.filter((f) => f.xy !== '??');
  const conflict = tracked.filter((f) => isConflict(f.xy));
  const ok = tracked.filter((f) => !isConflict(f.xy));
  const staged = ok.filter((f) => f.xy[0] !== ' ');
  const changed = ok.filter((f) => f.xy[1] !== ' ');
  const untracked = d.files.filter((f) => f.xy === '??');
  box.hidden = false; gitState.staged = staged.length; gitState.count = d.files.length; updateCommitBtn();
  if (!d.files.length) { list.append(el('div', 'hint', '変更はありません')); return; }
  badge.textContent = d.files.length; badge.hidden = false;
  gitSection(list, '競合', conflict, 'conflict');
  gitSection(list, 'ステージ済み', staged, 'staged');
  gitSection(list, '変更', changed, 'changed');
  gitSection(list, '未追跡', untracked, 'untracked');
}
let suggesting = false;
function updateSuggestBtn() { $('#suggestbtn').disabled = suggesting || gitState.staged === 0; }
$('#suggestbtn').onclick = async () => {
  if (suggesting || gitState.staged === 0) return;
  const box = $('#commitmsg');
  if (box.value.trim() && !confirm('入力中のメッセージを、AI の提案で置き換えますか？')) return;
  suggesting = true; const btn = $('#suggestbtn'); btn.textContent = '考え中…'; updateSuggestBtn(); gitMsg('');
  try {
    const r = await gitPost('suggest', {});
    box.value = r.message; gitMsg(r.truncated ? '✓ 提案しました (差分が長いため、一部のみ参照)。内容を確認して、必要なら直してください' : '✓ 提案しました。内容を確認して、必要なら直してください');
    box.focus(); box.setSelectionRange(0, 0);
  } catch (e) { gitMsg(e.message, true); }
  suggesting = false; btn.textContent = '✨ 提案'; updateSuggestBtn(); updateCommitBtn();
};
function updateCommitBtn() {
  updateSuggestBtn();
  const b = $('#commitbtn'); b.textContent = gitState.staged ? `コミット (${gitState.staged})` : 'コミット';
  b.disabled = !($('#commitmsg').value.trim() && gitState.staged > 0);
}
$('#commitmsg').addEventListener('input', updateCommitBtn);
$('#commitmsg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); $('#commitbtn').click(); } });
$('#commitbtn').onclick = async () => {
  const btn = $('#commitbtn'); if (btn.disabled) return; btn.disabled = true;
  try { const r = await gitPost('commit', { message: $('#commitmsg').value }); $('#commitmsg').value = ''; gitMsg(`✓ コミットしました ${r.hash}`); }
  catch (e) { gitMsg(e.message, true); }
  await loadGit();
};
// ---------- ブランチの切り替え (一覧から選ぶ / 新規作成) ----------
const brBtn = $('#gitbranch'), brMenu = $('#branchmenu');
function closeBranchMenu() { brMenu.hidden = true; brMenu.textContent = ''; }
async function switchBranch(name, create) {
  closeBranchMenu();
  try { await gitPost('switch', { branch: name, create }); gitMsg(`✓ ${create ? '作成して切り替えました' : '切り替えました'}: ${name}`); }
  catch (e) { gitMsg(e.message, true); }
  await loadGit(); refreshTree(); invalidateIndex(); // ブランチが変わるとファイルも変わる
}
async function openBranchMenu() {
  if (!brMenu.hidden) { closeBranchMenu(); return; }
  brMenu.textContent = ''; brMenu.hidden = false; brMenu.append(el('div', 'hint', 'ブランチを読み込み中…')); // 押した瞬間に開く (Git の応答を待たない)
  let b; try { b = await api('/api/git/branches', {}); } catch (e) { closeBranchMenu(); gitMsg(e.message, true); return; }
  if (brMenu.hidden) return; // 読み込み中に閉じられた
  brMenu.textContent = '';
  const dirty = gitState.count || 0;
  if (dirty) brMenu.append(el('div', 'bnote', `未コミットの変更が ${dirty} 件あります。切り替えで衝突する場合は Git が拒否します`));
  const filter = el('input', 'bfilter'); filter.placeholder = '検索 / 新しいブランチ名を入力'; filter.spellcheck = false; filter.autocomplete = 'off';
  const list = el('div', 'blist'); brMenu.append(filter, list);
  let items = []; let sel = 0;
  const render = () => {
    const q = filter.value.trim(); const ql = q.toLowerCase(); list.textContent = ''; items = [];
    const push = (label, sub, act, cls) => items.push({ label, sub, act, cls });
    for (const n of b.local) if (!ql || n.toLowerCase().includes(ql)) push(n, n === b.current && !b.detached ? '現在' : '', () => (n === b.current && !b.detached ? closeBranchMenu() : switchBranch(n, false)), n === b.current && !b.detached ? 'cur' : '');
    for (const n of b.remoteOnly) if (!ql || n.toLowerCase().includes(ql)) push(n, 'リモート', () => switchBranch(n, false), 'remote');
    const exists = b.local.includes(q) || b.remoteOnly.includes(q);
    if (q && !exists) push(`＋ 「${q}」を新しいブランチとして作成`, b.detached ? '現在の位置から' : `${b.current} から`, () => switchBranch(q, true), 'create');
    if (!items.length) list.append(el('div', 'hint', '一致するブランチがありません'));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    items.forEach((it, i) => {
      const row = el('div', `bit ${it.cls}${i === sel ? ' on' : ''}`); row.append(el('span', 'bn', it.label), ...(it.sub ? [el('span', 'bs', it.sub)] : []));
      row.onclick = it.act; list.append(row);
    });
    list.querySelector('.bit.on')?.scrollIntoView({ block: 'nearest' });
  };
  filter.addEventListener('input', () => { sel = 0; render(); });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); render(); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); items[sel]?.act(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeBranchMenu(); brBtn.focus(); }
  });
  render(); filter.focus();
}
brBtn.onclick = (e) => { e.stopPropagation(); openBranchMenu(); };
document.addEventListener('mousedown', (e) => { if (!brMenu.hidden && !brMenu.contains(e.target) && e.target !== brBtn) closeBranchMenu(); });

$('#gitrefresh').onclick = loadGit;

// HEAD と作業ツリーを左右に並べる (Monaco の差分エディタ、読み取り専用)
let diffEd = null;
function disposeDiffEditor() { if (!diffEd) return; try { diffEd.editor.dispose(); diffEd.a.dispose(); diffEd.b.dispose(); } catch { /* 無視 */ } diffEd = null; pv.body.classList.remove('editing'); }
async function renderSideDiff(rel) {
  let sides, m;
  try { [sides, m] = await Promise.all([api('/api/git/sides', { path: rel }), loadMonaco()]); } catch (e) { pv.body.append(el('div', 'note', e.message)); return; }
  if (!diffState || diffState.rel !== rel) return;
  pv.body.classList.add('editing'); const host = el('div', 'edhost'); pv.body.append(host);
  const uri = (k) => m.Uri.parse(`inmemory://cdock-diff/${k}/${encodeURI(rel)}`);
  const a = m.editor.createModel(sides.head ?? '', undefined, uri('head')); const b = m.editor.createModel(sides.work ?? '', undefined, uri('work'));
  const editor = m.editor.createDiffEditor(host, { automaticLayout: true, readOnly: true, originalEditable: false, renderSideBySide: pv.body.clientWidth > 700, minimap: { enabled: false }, scrollBeyondLastLine: false, hover: { enabled: false }, unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false }, wordWrap: 'on', padding: { top: 8, bottom: 8 } });
  editor.setModel({ original: a, modified: b });
  diffEd = { editor, a, b }; applyMonacoLook(editor);
  if (sides.head === null) pv.body.insertBefore(el('div', 'note', 'HEAD にはまだありません (新しいファイル)'), host);
  else if (sides.work === null) pv.body.insertBefore(el('div', 'note', '作業ツリーから削除されています'), host);
}
let diffSide = store.get('diffSide', '0') === '1'; // 並べて表示 (Monaco) にするか
async function openDiff(rel, untracked) {
  if (editState && !(await confirmLeaveEdit())) return;
  $('#pmode').hidden = true; $('#pedit').hidden = true; curDoc = null; mdState = null; diffState = { rel, untracked }; disposeDiffEditor();
  previewRel = null; pv.box.hidden = false; pv.name.textContent = `${untracked ? '未追跡' : '差分'}: ${rel}`; pv.body.textContent = '読み込み中…';
  let d; try { d = await api('/api/git/diff', { path: rel }); } catch (e) { pv.body.textContent = ''; pv.body.append(el('div', 'note', e.message)); return; }
  pv.body.textContent = ''; pv.body.scrollTop = 0;
  const sw = el('button', 'ghost mini diffsw', diffSide ? '行ごとに表示' : '並べて表示'); sw.type = 'button';
  sw.title = diffSide ? '従来の差分表示に戻す' : 'HEAD と作業ツリーを左右に並べて表示します (読み取り専用)';
  sw.onclick = () => { diffSide = !diffSide; store.set('diffSide', diffSide ? '1' : '0'); openDiff(rel, untracked); };
  pv.body.append(sw);
  if (diffSide) { await renderSideDiff(rel); return; }
  const wrap = el('div', 'diff'); wrap.style.maxHeight = 'none'; wrap.style.border = '1px solid var(--rule)'; wrap.style.borderRadius = '10px';
  const lines = d.text.split(NL); if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) wrap.append(el('div', 'dl', '(差分はありません)'));
  for (const ln of lines) {
    const cls = d.untracked ? 'add' : ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff ') || ln.startsWith('index ') ? 'dh2' : ln.startsWith('@@') ? 'hunk' : ln[0] === '+' ? 'add' : ln[0] === '-' ? 'del' : '';
    const row = el('div', `dl ${cls}`); row.textContent = d.untracked ? `+ ${ln}` : ln; wrap.append(row);
  }
  pv.body.append(wrap);
}

// ---------- ファイル検索 (名前 / 中身)。Ctrl+P で検索欄へ ----------
let fileIndex = null, fileIndexCwd = '', searchMode = 'name', grepTimer = null, fsel = -1, searchSeq = 0;
const fsInput = $('#fsearch'), fres = $('#fresults');
function invalidateIndex() { fileIndex = null; }
async function ensureIndex() {
  const cwd = cwdEl.value.trim();
  if (fileIndex && fileIndexCwd === cwd) return fileIndex;
  try { fileIndex = (await api('/api/files', {})).files; fileIndexCwd = cwd; } catch { fileIndex = []; }
  return fileIndex;
}
// あいまい一致: 全ての語が (ファイル名 > パス > 飛び飛びの文字) のいずれかで一致すること
function fuzzyOne(q, p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const bi = base.indexOf(q); if (bi >= 0) return 1000 - bi - base.length * 0.1;
  const pi = p.indexOf(q); if (pi >= 0) return 600 - pi * 0.1 - p.length * 0.05;
  let i = 0, last = -2, score = 0;
  for (const ch of q) { const j = p.indexOf(ch, i); if (j < 0) return -1; score += j === last + 1 ? 3 : 1; last = j; i = j + 1; }
  return score - p.length * 0.02;
}
function fuzzyScore(terms, path) {
  const p = path.toLowerCase(); let total = 0;
  for (const t of terms) { const s = fuzzyOne(t, p); if (s < 0) return -1; total += s; }
  return total;
}
function searchItems() { return [...fres.querySelectorAll('.fres-it')]; }
function setSel(i) {
  const items = searchItems(); if (!items.length) { fsel = -1; return; }
  fsel = (i + items.length) % items.length;
  items.forEach((e, k) => e.classList.toggle('on', k === fsel)); items[fsel].scrollIntoView({ block: 'nearest' });
}
function clearSearch() { fsInput.value = ''; fres.hidden = true; fres.textContent = ''; $('#tree').hidden = false; fsel = -1; }
function nameItem(path) {
  const slash = path.lastIndexOf('/'); const base = path.slice(slash + 1), dir = slash >= 0 ? path.slice(0, slash) : '';
  const it = el('div', 'fres-it'); it.title = path;
  it.append(el('span', 'fb', base), el('span', 'fd', dir));
  const at = el('span', 'at2', '＠'); at.title = '入力欄に @パス を挿入';
  at.onclick = (ev) => { ev.stopPropagation(); insertAtCursor(atRef(path)); };
  it.append(at); it.onclick = () => openPreview(path); it.dataset.path = path; dragSource(it, path);
  return it;
}
async function runSearch() {
  const q = fsInput.value.trim(); const seq = ++searchSeq;
  if (!q) { clearSearch(); return; }
  $('#tree').hidden = true; fres.hidden = false;
  if (searchMode === 'name') {
    const files = await ensureIndex(); if (seq !== searchSeq) return;
    const terms = q.toLowerCase().split(' ').filter(Boolean);
    const scored = []; for (const f of files) { const s = fuzzyScore(terms, f); if (s >= 0) scored.push([s, f]); }
    scored.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length);
    fres.textContent = '';
    if (!scored.length) fres.append(el('div', 'hint', '一致するファイルがありません'));
    for (const [, f] of scored.slice(0, 100)) fres.append(nameItem(f));
    if (scored.length > 100) fres.append(el('div', 'hint', `他 ${scored.length - 100} 件 (語を増やして絞り込めます)`));
    setSel(0);
  } else {
    if (q.length < 2) { fres.textContent = ''; fres.append(el('div', 'hint', '2 文字以上で検索します')); return; }
    fres.textContent = ''; fres.append(el('div', 'hint', '検索中…'));
    let d; try { d = await api('/api/grep', { q }); } catch (e) { fres.textContent = ''; fres.append(el('div', 'hint', e.message)); return; }
    if (seq !== searchSeq) return;
    fres.textContent = '';
    if (!d.hits.length) { fres.append(el('div', 'hint', '一致する行がありません')); return; }
    let cur = null;
    for (const h of d.hits) {
      if (h.path !== cur) { cur = h.path; const t = el('div', 'fres-file', h.path); t.title = h.path; fres.append(t); }
      const it = el('div', 'fres-it hit'); it.dataset.path = h.path; it.dataset.line = h.line;
      it.append(el('span', 'ln', String(h.line)), el('span', 'ltx', h.text.trim()));
      it.onclick = () => openPreview(h.path, null, h.line); dragSource(it, h.path); fres.append(it);
    }
    if (d.truncated) fres.append(el('div', 'hint', '先頭 200 件のみ表示しています。語を増やして絞り込んでください'));
    setSel(0);
  }
}
fsInput.addEventListener('input', () => { clearTimeout(grepTimer); grepTimer = setTimeout(runSearch, searchMode === 'content' ? 300 : 60); });
fsInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setSel(fsel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(fsel - 1); }
  else if (e.key === 'Enter' && !e.isComposing) {
    const it = searchItems()[fsel]; if (!it) return; e.preventDefault();
    if (e.shiftKey && it.dataset.path) insertAtCursor(atRef(it.dataset.path)); else it.click();
  } else if (e.key === 'Escape') { e.preventDefault(); clearSearch(); }
});
$('#treerefresh').onclick = () => { invalidateIndex(); refreshTree(); loadGit(); };
$('#fsmode').onclick = () => {
  searchMode = searchMode === 'name' ? 'content' : 'name';
  $('#fsmode').textContent = searchMode === 'name' ? '名前' : '中身';
  fsInput.placeholder = searchMode === 'name' ? 'ファイルを検索 (Ctrl+P)' : '中身を検索 (2文字以上)';
  fsInput.focus(); runSearch();
};
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); showTab('files'); fsInput.focus(); fsInput.select(); }
});

// ---------- 添付 (ドラッグ＆ドロップ / Ctrl+V の貼り付け / 📎) ----------
// ブラウザはファイルの場所を教えないので、中身をサーバーの一時フォルダへ送り、その場所を Claude に伝える。
const MAX_UPLOAD_MB = 50, MAX_ATTACH = 20;
let attachments = []; // { name, size, path, status: 'uploading' | 'ready' | 'error', error, thumb }
const attachBox = $('#attach');
function chipEl(a, removable) {
  const chip = el('div', `chip ${a.status || 'ready'}`);
  if (a.thumb) { const im = el('img'); im.src = a.thumb; im.alt = ''; chip.append(im); } else chip.append(el('span', 'ci', a.dir ? '📁' : '📄'));
  const sub = a.status === 'uploading' ? 'アップロード中…' : a.status === 'error' ? (a.error || 'エラー') : (a.sub || (a.size != null ? fmtSize(a.size) : ''));
  const meta = el('span', 'cm'); meta.append(el('span', 'cn', a.name), ...(sub ? [el('span', 'cs', sub)] : []));
  chip.title = a.name; chip.append(meta);
  if (removable) {
    const x = el('button', 'cx', '✕'); x.title = '外す'; x.type = 'button';
    x.onclick = () => { attachments = attachments.filter((z) => z !== a); renderAttach(); };
    chip.append(x);
  }
  return chip;
}
function renderAttach() {
  attachBox.textContent = ''; attachBox.hidden = !attachments.length;
  for (const a of attachments) attachBox.append(chipEl(a, true));
  const uploading = attachments.some((a) => a.status === 'uploading');
  sendBtn.disabled = uploading; sendBtn.title = uploading ? 'アップロードが終わるまでお待ちください' : '';
}
async function addFiles(fileList) {
  for (const f of [...fileList]) {
    if (attachments.length >= MAX_ATTACH) { add(el('div', 'err-box', `添付は ${MAX_ATTACH} 件までです`)); break; }
    const a = { name: f.name || 'file', size: f.size, status: 'uploading', thumb: f.type && f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
    attachments.push(a);
    if (f.size > MAX_UPLOAD_MB * 1048576) { a.status = 'error'; a.error = `大きすぎます (上限 ${MAX_UPLOAD_MB}MB)`; renderAttach(); continue; }
    renderAttach();
    try {
      const r = await fetch(`/api/upload?name=${encodeURIComponent(a.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.path) throw new Error(j.error || `エラー ${r.status}`);
      a.path = j.path; a.status = 'ready';
    } catch (e) { a.status = 'error'; a.error = e.message; }
    renderAttach();
  }
}
// 左のエクスプローラ / 検索結果からドロップされたファイル (プロジェクト内。アップロード不要)
function dragSource(node, rel) {
  node.draggable = true;
  node.ondragstart = (ev) => {
    ev.dataTransfer.setData(REF_TYPE, rel);
    ev.dataTransfer.setData('text/plain', `${atRef(rel)} `); // 他のアプリへ落とした場合は @パス の文字になる
    ev.dataTransfer.effectAllowed = 'copy';
  };
}
function addRef(rel) {
  if (attachments.some((a) => a.rel === rel)) return;
  if (attachments.length >= MAX_ATTACH) { add(el('div', 'err-box', `添付は ${MAX_ATTACH} 件までです`)); return; }
  const dir = rel.endsWith('/'); const clean = dir ? rel.slice(0, -1) : rel; const slash = clean.lastIndexOf('/'); // 末尾が / のものはディレクトリ
  attachments.push({ name: clean.slice(slash + 1) + (dir ? '/' : ''), sub: slash >= 0 ? clean.slice(0, slash) : 'プロジェクト内', rel, dir, status: 'ready' });
  renderAttach();
}
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
// 貼り付けられた画像は名前が "image.png" になるので、日時入りの名前にする
const namePasted = (f) => (/^image\.[a-z]+$/i.test(f.name) ? new File([f], `貼り付け-${stamp()}.${f.name.split('.').pop()}`, { type: f.type }) : f);
input.addEventListener('paste', (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length) return; e.preventDefault(); addFiles(files.map(namePasted));
});
$('#attbtn').onclick = () => $('#filepick').click();
$('#filepick').onchange = () => { addFiles($('#filepick').files); $('#filepick').value = ''; };

// ドラッグ中は画面全体に「ここにドロップ」を表示する
const dropzone = $('#dropzone'); let dragDepth = 0;
const REF_TYPE = 'application/x-cdock-path';
const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].some((t) => t === 'Files' || t === REF_TYPE));
const dragEnd = () => { dragDepth = 0; dropzone.hidden = true; document.body.classList.remove('dragging'); };
const overTree = (e) => !!(e.target && e.target.closest && e.target.closest('#pane-files')) && [...e.dataTransfer.types].includes(MOVE_TYPE);
window.addEventListener('dragenter', (e) => { if (overTree(e)) { dropzone.hidden = true; return; } if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropzone.hidden = false; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', (e) => { if (overTree(e)) return; if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragEnd(); });
window.addEventListener('drop', (e) => {
  if (overTree(e)) { dragEnd(); return; } // ツリーの上のドロップは、ツリー側 (移動) が処理する
  if (!hasFiles(e)) return; e.preventDefault(); dragEnd();
  const ref = e.dataTransfer.getData(REF_TYPE);
  if (ref) { addRef(ref); input.focus(); return; } // 左のエクスプローラから: アップロードせず、プロジェクト内のファイルとして添付
  const files = []; let folders = 0;
  for (const it of [...e.dataTransfer.items]) {
    if (it.kind !== 'file') continue;
    const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (entry && entry.isDirectory) { folders++; continue; }
    const f = it.getAsFile(); if (f) files.push(f);
  }
  if (folders) add(el('div', 'err-box', 'フォルダは添付できません (ファイルだけ受け付けます)'));
  if (files.length) { input.focus(); addFiles(files); }
});
window.addEventListener('dragend', dragEnd);

// 履歴から開いたときは、末尾の <attachments> ブロックをチップに戻して表示する
function splitAttachments(t) {
  const i = t.indexOf('<attachments>');
  if (i < 0) return { text: t, files: [] };
  const rest = t.slice(i + '<attachments>'.length).split('</attachments>')[0];
  const files = rest.split(NL).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
  return { text: t.slice(0, i).trimEnd(), files };
}
function userBubble(text, files) {
  const b = el('div', 'msg user'); b.append(el('div', 'ut', text));
  if (files && files.length) { const row = el('div', 'uchips'); for (const a of files) row.append(chipEl(a, false)); b.append(row); }
  return b;
}

// ---------- フォルダの切り替え / 選択 ----------
const recentDirs = () => { try { return JSON.parse(store.get('recentDirs', '[]')); } catch { return []; } };
function fillRecentList() { const dl = $('#recent-dirs'); dl.textContent = ''; for (const p of recentDirs()) { const o = el('option'); o.value = p; dl.append(o); } }
function pushRecent(p) { store.set('recentDirs', JSON.stringify([p, ...recentDirs().filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 10))); fillRecentList(); }
let lastGoodCwd = '', cwdParent = null;
// 「一つ上へ」ボタン (昔の Windows エクスプローラーの ↑ と同じ。Alt+↑ でも可)
function setParent(p) {
  cwdParent = p || null; const b = $('#cwd-up'); b.disabled = !cwdParent;
  b.title = cwdParent ? `一つ上のフォルダへ: ${cwdParent} (Alt+↑)` : '一番上のフォルダです';
}
async function refreshParent() { try { setParent((await api('/api/dirs', { path: cwdEl.value.trim() })).parent); } catch { setParent(null); } }
$('#cwd-up').onclick = () => { if (cwdParent) switchCwd(cwdParent); };
document.addEventListener('keydown', (e) => {
  if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key === 'ArrowUp' && !e.target.closest?.('.monaco-editor')) {
    e.preventDefault();
    if (!dlg.box.hidden) $('#dlg-up').click(); else if (cwdParent) switchCwd(cwdParent);
  }
});
// フォルダが存在するか確かめてから、会話・ツリー・Git・コマンドを読み込み直す。存在しなければ赤で知らせる
async function switchCwd(raw) {
  const value = raw.trim(); if (!value) return false;
  if (busy) { cwdEl.value = lastGoodCwd; return false; }
  if (editState && !(await confirmLeaveEdit())) { cwdEl.value = lastGoodCwd; return false; }
  try { const d = await api('/api/dirs', { path: value }); cwdEl.classList.remove('invalid'); cwdEl.title = ''; cwdEl.value = d.path; setParent(d.parent); renderCrumbs(); }
  catch (e) { cwdEl.classList.add('invalid'); cwdEl.title = `フォルダが見つかりません: ${e.message}`; renderCrumbs(); return false; }
  if (cwdEl.value === lastGoodCwd) return true;
  lastGoodCwd = cwdEl.value; store.set('cwd', cwdEl.value); pushRecent(cwdEl.value); invalidateIndex(); clearSearch();
  ws.send(JSON.stringify({ type: 'newSession' })); currentSession = null; clearChat(); loadSessions(); loadRoot(); loadCommands(); loadGit(); watchCwd();
  return true;
}
cwdEl.addEventListener('change', () => switchCwd(cwdEl.value));
fillRecentList();

// ---------- 場所のバー: クリックできるパス (パンくず) / パスの入力 / Git のチップ ----------
// 作業フォルダ = 会話・ファイル・変更 (Git) の前提。パスの各部分を押すと、そこを作業フォルダにする
function pathParts(p) {
  const unc = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(p); // \\server\share
  const win = /^[A-Za-z]:/.test(p);
  const sep = p.includes('\\') || win || unc ? '\\' : '/';
  const names = p.split(/[\\/]+/).filter(Boolean);
  const parts = [];
  if (unc) { const root = `\\\\${names[0]}\\${names[1]}`; parts.push({ label: root, path: `${root}\\` }); names.splice(0, 2); let acc = root; for (const n of names) { acc += `\\${n}`; parts.push({ label: n, path: acc }); } return parts; }
  if (win) { const drive = names.shift(); parts.push({ label: `${drive}\\`, path: `${drive}\\` }); let acc = drive; for (const n of names) { acc += `\\${n}`; parts.push({ label: n, path: acc }); } return parts; }
  parts.push({ label: '/', path: '/' }); let acc = '';
  for (const n of names) { acc += `/${n}`; parts.push({ label: n, path: acc }); }
  return parts;
}
const crumbsEl = $('#crumbs');
function renderCrumbs() {
  const p = cwdEl.value.trim(); crumbsEl.textContent = ''; crumbsEl.classList.toggle('invalid', cwdEl.classList.contains('invalid'));
  crumbsEl.title = p ? `作業フォルダ: ${p}\n(各部分をクリックでそのフォルダへ / 空いている所をクリックでパスを入力)` : '作業フォルダが未設定です (クリックして入力)';
  if (!p) { crumbsEl.append(el('span', 'crumb-empty', 'フォルダを選んでください')); return; }
  const parts = pathParts(p);
  parts.forEach((part, i) => {
    if (i > 0) crumbsEl.append(el('span', 'crumbsep', '›'));
    const b = el('button', `crumb${i === parts.length - 1 ? ' cur' : ''}`, part.label); b.type = 'button'; b.title = part.path;
    b.onclick = (e) => { e.stopPropagation(); if (i < parts.length - 1) switchCwd(part.path); else startCwdEdit(); }; // 現在の場所を押すと、パスの入力へ
    crumbsEl.append(b);
  });
  crumbsEl.classList.toggle('clip', crumbsEl.scrollWidth > crumbsEl.clientWidth + 1);
}
function startCwdEdit() { crumbsEl.hidden = true; cwdEl.hidden = false; cwdEl.focus(); cwdEl.select(); }
function endCwdEdit() { cwdEl.hidden = true; crumbsEl.hidden = false; renderCrumbs(); }
crumbsEl.addEventListener('click', startCwdEdit);
cwdEl.addEventListener('blur', () => setTimeout(endCwdEdit, 120)); // 変更の処理 (change) が先に走るよう、少し待つ
cwdEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cwdEl.value = lastGoodCwd || cwdEl.value; cwdEl.classList.remove('invalid'); endCwdEdit(); }
  else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); const v = cwdEl.value; switchCwd(v).then(endCwdEdit); } // 確定したら、パンくずの表示に戻る
});
window.addEventListener('resize', () => { if (!crumbsEl.hidden) renderCrumbs(); });
// ツリーのフォルダを、作業フォルダにする (右クリックメニューから)
let treeRoot = '';
function absPath(rel) { const sep = treeRoot.includes('\\') || /^[A-Za-z]:/.test(treeRoot) ? '\\' : '/'; return treeRoot + (treeRoot.endsWith(sep) ? '' : sep) + rel.split('/').join(sep); }

const dlg = { box: $('#dlg'), list: $('#dlg-list'), pathIn: $('#dlg-pathinput'), filter: $('#dlg-filter'), cur: '', parent: null, dirs: [], sep: '/', first: null, repos: {}, isRepo: false };
const dlgJoin = (base, name) => (base.endsWith('\\') || base.endsWith('/') ? base + name : base + dlg.sep + name);
async function dlgLoad(p, fallback) {
  try {
    const d = await api('/api/dirs', { path: p, hidden: $('#dlg-hidden').checked ? '1' : '0', fallback: fallback ? '1' : '0' });
    Object.assign(dlg, { cur: d.path, parent: d.parent, dirs: d.dirs, sep: d.sep, repos: d.repos || {}, isRepo: !!d.isRepo });
    const note = $('#dlg-note'); note.hidden = !d.fellBack;
    if (d.fellBack) note.textContent = `「${p}」はフォルダとして開けないため、いちばん近いフォルダを表示しています`;
    dlg.pathIn.value = d.path; $('#dlg-cur').textContent = d.path; $('#dlg-up').disabled = !d.parent; dlg.filter.value = '';
    dlgPlaces(d); dlgRender();
  } catch (e) { dlg.list.textContent = ''; dlg.list.append(el('div', 'hint', e.message)); }
}
function dlgPlaces(d) {
  const box = $('#dlg-places'); box.textContent = '';
  const add = (label, p) => { const x = el('div', 'dlg-pl', label); x.title = p; x.onclick = () => dlgLoad(p); box.append(x); };
  add('ホーム', d.home); for (const dr of d.drives) add(`ドライブ ${dr}`, dr);
  const rec = $('#dlg-recent'); rec.textContent = '';
  const list = recentDirs(); if (!list.length) rec.append(el('div', 'hint', '(まだありません)'));
  for (const p of list) { const x = el('div', 'dlg-pl', p.split(/[\\/]/).filter(Boolean).pop() || p); x.title = p; x.onclick = () => dlgLoad(p); rec.append(x); }
}
function dlgRender() {
  const q = dlg.filter.value.trim().toLowerCase(); const only = $('#dlg-onlyrepos').checked;
  const items = dlg.dirs.filter((n) => (!q || n.toLowerCase().includes(q)) && (!only || dlg.repos[n]));
  const repoCount = Object.keys(dlg.repos).length;
  $('#dlg-cur').textContent = `${dlg.cur}${dlg.isRepo ? '  (Git リポジトリ)' : ''}`;
  $('#dlg-onlyrepos-label').hidden = !repoCount; // このフォルダの下にリポジトリがあるときだけ、絞り込みを出す
  dlg.list.textContent = '';
  if (!items.length) dlg.list.append(el('div', 'hint', only ? 'リポジトリがありません' : q ? '一致するフォルダがありません' : 'サブフォルダはありません'));
  for (const n of items) {
    const full = dlgJoin(dlg.cur, n); const it = el('div', 'dlg-it');
    it.append(el('span', '', dlg.repos[n] ? '🔀' : '📁'), el('span', 'dn', n));
    if (dlg.repos[n]) { const rb = el('span', 'rb', `⎇ ${dlg.repos[n]}`); rb.title = 'Git のリポジトリ (現在のブランチ)'; it.append(rb); }
    const pick = el('button', 'ghost pick', '選ぶ'); pick.type = 'button'; pick.title = 'このフォルダを作業フォルダにして閉じる';
    pick.onclick = async (e) => { e.stopPropagation(); if (await switchCwd(full)) dlgClose(); };
    it.append(pick); it.onclick = () => dlgLoad(full); dlg.list.append(it);
  }
  dlg.first = items[0] ? dlgJoin(dlg.cur, items[0]) : null;
}
function dlgClose() { dlg.box.hidden = true; cwdEl.focus(); }
$('#cwd-browse').onclick = () => { dlg.box.hidden = false; dlgLoad(cwdEl.value.trim(), true); dlg.filter.focus(); };
$('#dlg-close').onclick = dlgClose; $('#dlg-cancel').onclick = dlgClose;
$('#dlg-up').onclick = () => { if (dlg.parent) dlgLoad(dlg.parent); };
$('#dlg-hidden').onchange = () => dlgLoad(dlg.cur);
$('#dlg-onlyrepos').onchange = dlgRender;
dlg.filter.oninput = dlgRender;
dlg.filter.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing && dlg.first) { e.preventDefault(); dlgLoad(dlg.first); } };
dlg.pathIn.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); dlgLoad(dlg.pathIn.value); } };
$('#dlg-ok').onclick = async () => { if (await switchCwd(dlg.cur)) dlgClose(); };
dlg.box.addEventListener('keydown', (e) => { if (e.key === 'Escape') dlgClose(); });
dlg.box.addEventListener('mousedown', (e) => { if (e.target === dlg.box) dlgClose(); });

// ---------- 行間・余白 (詰める / 標準 / ゆったり) ----------
const DENSITIES = [['compact', '詰める'], ['normal', '標準'], ['roomy', 'ゆったり']];
let densityIdx = Math.max(0, DENSITIES.findIndex((d) => d[0] === store.get('density', 'normal')));
function applyDensity() {
  const [name, label] = DENSITIES[densityIdx];
  if (name === 'normal') document.documentElement.removeAttribute('data-density'); else document.documentElement.setAttribute('data-density', name);
  $('#density').title = `行間: ${label} (クリックで切り替え)`; $('#density').textContent = name === 'compact' ? '≡' : name === 'normal' ? '☰' : '☷'; store.set('density', name);
}
$('#density').onclick = () => { densityIdx = (densityIdx + 1) % DENSITIES.length; applyDensity(); };
applyDensity();

// ---------- テーマ (自動 / ライト / ダーク)。自動は OS の設定に従う ----------
const THEMES = [['auto', '◐', '自動 (OS の設定に従う)'], ['light', '☀', 'ライト'], ['dark', '☾', 'ダーク']];
let themeIdx = Math.max(0, THEMES.findIndex((t) => t[0] === store.get('theme', 'auto')));
function applyTheme() {
  const [name, icon, label] = THEMES[themeIdx];
  if (name === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', name);
  $('#theme').textContent = icon; $('#theme').title = `テーマ: ${label} (クリックで切り替え)`; store.set('theme', name); syncEditorTheme(); if (mdState && !mdRaw && !editState) renderMdPreview(); // 図の配色も、テーマに合わせて描き直す
}
$('#theme').onclick = () => { themeIdx = (themeIdx + 1) % THEMES.length; applyTheme(); };
applyTheme();

// ---------- 文字サイズ (画面全体) (A− / A＋、記憶する) ----------
const FS_MIN = 12, FS_MAX = 20, FS_DEFAULT = 14;
function setChatFs(n) {
  const v = Math.max(FS_MIN, Math.min(FS_MAX, n));
  document.documentElement.style.setProperty('--fs', `${v}px`); store.set('chatFs', String(v)); syncEditorTheme();
  $('#fs-down').disabled = v <= FS_MIN; $('#fs-up').disabled = v >= FS_MAX; $('.fs').title = `文字サイズ (画面全体): ${v}px (ダブルクリックで初期値)`;
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
