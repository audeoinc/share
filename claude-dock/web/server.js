// cdock web — Claude Code をブラウザで使うローカル UI (Claude Agent SDK)
// 起動: node server.js [--port 8787] [--cwd <作業フォルダ>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { query, listSessions, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, 'public');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const PORT = Number(arg('port', process.env.CDOCK_WEB_PORT || 8787));
const HOST = '127.0.0.1';
const DEFAULT_CWD = path.resolve(arg('cwd', process.cwd()));
const TOKEN = process.env.CDOCK_WEB_TOKEN || crypto.randomBytes(24).toString('hex');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---- 認証: 起動ごとのトークン (初回は ?t=、以降は Cookie)。他サイトからの接続は Origin で拒否
function cookieToken(req) {
  const m = /(?:^|;\s*)cdock_t=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // 同一オリジンの GET などは Origin なし
  try { const u = new URL(o); return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port || 80) === PORT; } catch { return false; }
}

const IGNORE = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.DS_Store']);
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const resolveCwd = (c) => { const p = c && fs.existsSync(c) ? path.resolve(c) : DEFAULT_CWD; return p; };


// ---- ファイルプレビュー用 ----
const RAW_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
const MAX_TEXT = 1024 * 1024, MAX_RAW = 30 * 1024 * 1024, MAX_ZIP = 60 * 1024 * 1024;

// 作業フォルダの外 (シンボリックリンク経由を含む) は読ませない
function safeFile(cwd, rel) {
  const root = fs.realpathSync(cwd);
  const f = fs.realpathSync(path.resolve(cwd, rel));
  if (f !== root && !f.startsWith(root + path.sep)) throw new Error('作業フォルダの外のファイルは開けません');
  return f;
}
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { try { return new TextDecoder('shift_jis').decode(buf); } catch { return buf.toString('latin1'); } }
}
// 最小の ZIP リーダー (pptx / docx 用)。ZIP64 は非対応。展開サイズに上限を付ける
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP として読めません');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    files.set(name, () => {
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: 8 * 1024 * 1024 });
    });
    p += 46 + nl + el + cl;
  }
  return files;
}
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function paragraphs(xml, pTag, tTag) {
  const out = [];
  for (const m of xml.matchAll(new RegExp(`<${pTag}[ >][^]*?</${pTag}>`, 'g'))) {
    const t = [...m[0].matchAll(new RegExp(`<${tTag}[^>]*>([^]*?)</${tTag}>`, 'g'))].map((x) => xmlText(x[1])).join('');
    if (t.trim()) out.push(t);
  }
  return out;
}
function previewOffice(buf, ext) {
  if (buf.length > MAX_ZIP) return { kind: 'binary', note: 'ファイルが大きすぎて内容を表示できません' };
  const zip = readZip(buf);
  if (ext === '.pptx') {
    const slides = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    return { kind: 'pptx', slides: slides.map((k, i) => ({ n: i + 1, lines: paragraphs(zip.get(k)().toString('utf8'), 'a:p', 'a:t') })) };
  }
  const doc = zip.get('word/document.xml');
  return { kind: 'docx', lines: doc ? paragraphs(doc().toString('utf8'), 'w:p', 'w:t') : [] };
}
function previewFile(file, name) {
  const st = fs.statSync(file); const ext = path.extname(name).toLowerCase();
  const base = { name, size: st.size };
  if (RAW_MIME[ext]) return st.size > MAX_RAW ? { ...base, kind: 'binary', note: 'ファイルが大きすぎます' } : { ...base, kind: ext === '.pdf' ? 'pdf' : 'image' };
  if (ext === '.pptx' || ext === '.docx') return { ...base, ...previewOffice(fs.readFileSync(file), ext) };
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(Math.min(4096, st.size)); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
  if (head.includes(0)) return { ...base, kind: 'binary', note: 'バイナリファイルのため表示できません' };
  const buf = fs.readFileSync(file, { encoding: null }).subarray(0, MAX_TEXT);
  return { ...base, kind: /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text', text: decodeText(buf), truncated: st.size > MAX_TEXT };
}

// ---- Git (読み取りのみ。シェルを通さず引数配列で実行) ----
function git(cwd, args, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args],
      { cwd, maxBuffer: max, timeout: 15000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
async function gitStatus(cwd) {
  let top;
  try { top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); } catch { return { repo: false }; }
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
  const parts = raw.split('\0'); const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; if (e.length < 4) continue;
    const xy = e.slice(0, 2); const p = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // 次のエントリは元のパス
    files.push({ path: p, xy });
  }
  return { repo: true, top, branch, files };
}
// 差分: HEAD との比較 (ステージ済み + 未ステージ)。未追跡ファイルは全行を追加として返す
async function gitDiff(cwd, rel) {
  const st = await gitStatus(cwd); if (!st.repo) throw new Error('Git リポジトリではありません');
  const abs = path.resolve(st.top, rel);
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs; const root = fs.realpathSync(st.top);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('リポジトリの外のファイルです');
  const f = st.files.find((x) => x.path === rel);
  if (f && f.xy === '??') {
    const buf = fs.readFileSync(abs).subarray(0, MAX_TEXT);
    return { untracked: true, text: decodeText(buf) };
  }
  const text = await git(st.top, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', rel], 4 * 1024 * 1024).catch(async () => git(st.top, ['diff', '--no-color', '--no-ext-diff', '--', rel], 4 * 1024 * 1024));
  return { untracked: false, text };
}

// ---- スラッシュコマンド一覧 (SDK から取得して作業フォルダごとに保存) ----
const cmdCache = new Map();
const FALLBACK_COMMANDS = [{ name: 'compact', description: '会話を要約して、コンテキストを小さくする', argumentHint: '[指示]' }, { name: 'context', description: 'コンテキストの使用状況を表示', argumentHint: '' }, { name: 'cost', description: '使用量を表示', argumentHint: '' }];
async function listCommands(cwd) {
  if (cmdCache.has(cwd)) return cmdCache.get(cwd);
  async function* idle() { await new Promise(() => {}); }
  const q = query({ prompt: idle(), options: { cwd, settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' } } });
  let list = FALLBACK_COMMANDS;
  try {
    const cmds = await Promise.race([q.supportedCommands(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
    if (Array.isArray(cmds) && cmds.length) list = cmds.map((c) => ({ name: c.name, description: c.description || '', argumentHint: c.argumentHint || '' }));
    cmdCache.set(cwd, list);
  } catch { /* フォールバックを返す (キャッシュしない) */ } finally { try { q.close(); } catch { /* 無視 */ } }
  return list;
}
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function api(url, res, req) {
  const cwd = resolveCwd(url.searchParams.get('cwd'));
  try {
    if (url.pathname === '/api/commands') return json(res, await listCommands(cwd));
    if (url.pathname === '/api/git/status') return json(res, await gitStatus(cwd));
    if (url.pathname === '/api/git/diff') return json(res, await gitDiff(cwd, url.searchParams.get('path') || ''));
    if (url.pathname === '/api/rename' && req.method === 'POST') {
      let b; try { b = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'bad request' }, 400); }
      const id = String(b.id || ''); const title = String(b.title || '').trim().slice(0, 200);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !title) return json(res, { error: 'bad request' }, 400);
      await renameSession(id, title, { dir: cwd });
      return json(res, { ok: true });
    }
    if (url.pathname === '/api/sessions') {
      const list = await listSessions({ dir: cwd, limit: 60 });
      return json(res, list.map((x) => ({ sessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || '(無題)', lastModified: x.lastModified })));
    }
    if (url.pathname === '/api/session') {
      const id = url.searchParams.get('id') || '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res, { error: 'bad id' }, 400);
      const msgs = await getSessionMessages(id, { dir: cwd });
      return json(res, msgs.map((m) => ({ type: m.type, uuid: m.uuid, parent_tool_use_id: m.parent_tool_use_id, message: m.message })));
    }
    if (url.pathname === '/api/file' || url.pathname === '/api/raw') {
      const rel = url.searchParams.get('path') || '';
      const file = safeFile(cwd, rel); const name = path.basename(file);
      if (url.pathname === '/api/file') return json(res, previewFile(file, name));
      const ext = path.extname(name).toLowerCase(); const mime = RAW_MIME[ext];
      if (!mime) return json(res, { error: 'unsupported' }, 415);
      const buf = fs.readFileSync(file);
      const headers = { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (ext === '.svg') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
      res.writeHead(200, headers); return res.end(buf);
    }
    if (url.pathname === '/api/tree') {
      const target = path.resolve(cwd, url.searchParams.get('dir') || '.');
      if (target !== cwd && !target.startsWith(cwd + path.sep)) return json(res, { error: 'outside of folder' }, 403);
      const ents = fs.readdirSync(target, { withFileTypes: true }).filter((e) => !IGNORE.has(e.name)).slice(0, 1000)
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ja') : a.dir ? -1 : 1));
      return json(res, { root: cwd, entries: ents });
    }
  } catch (e) { return json(res, { error: String(e && e.message || e) }, 500); }
  return json(res, { error: 'not found' }, 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!originOk(req)) { res.writeHead(403); return res.end('forbidden'); }
  const qt = url.searchParams.get('t');
  if (qt && safeEqual(qt, TOKEN)) {
    res.writeHead(302, { 'Set-Cookie': `cdock_t=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`, Location: url.pathname });
    return res.end();
  }
  if (!safeEqual(cookieToken(req), TOKEN)) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('起動時に表示された URL (?t=...) から開いてください。'); }
  if (url.pathname.startsWith('/api/')) return api(url, res, req);
  let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(pub, rel));
  if (!file.startsWith(pub + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

// ---- WebSocket: 1 接続 = 1 画面。ターンごとに query() を起動し、session_id で resume する
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!originOk(req) || !safeEqual(cookieToken(req), TOKEN)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const pending = new Map(); // permission id -> { resolve, suggestions, input }
  let running = null;        // { q, abort }
  let sessionId = null;

  send({ type: 'hello', cwd: DEFAULT_CWD });

  async function runTurn({ text, cwd, permissionMode, model }) {
    if (running) return send({ type: 'error', message: '前の応答がまだ実行中です' });
    const abort = new AbortController();
    const workDir = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : DEFAULT_CWD;
    const options = {
      cwd: workDir,
      abortController: abort,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: permissionMode || 'default',
      ...(model ? { model } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      canUseTool: (toolName, input, opts) => new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pending.set(id, { resolve, suggestions: opts.suggestions, input });
        opts.signal.addEventListener('abort', () => { pending.delete(id); reject(new Error('aborted')); }, { once: true });
        send({ type: 'permission_request', id, toolName, input, title: opts.title, displayName: opts.displayName, reason: opts.decisionReason, blockedPath: opts.blockedPath, hasSuggestions: !!(opts.suggestions && opts.suggestions.length) });
      }),
    };
    if (process.env.CDOCK_WEB_MOCK) return mockTurn(text, abort);
    const q = query({ prompt: text, options });
    running = { q, abort };
    send({ type: 'busy', value: true });
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id;
        send({ type: 'sdk', msg });
      }
    } catch (e) {
      if (!abort.signal.aborted) send({ type: 'error', message: String(e && e.message || e) });
    } finally {
      running = null;
      pending.clear();
      send({ type: 'busy', value: false });
    }
  }

  // 開発用の模擬応答 (CDOCK_WEB_MOCK=1): 認証なしで画面の動作確認ができる
  async function mockTurn(text, abort) {
    running = { q: { interrupt: async () => abort.abort(), setPermissionMode: async () => {} }, abort };
    send({ type: 'busy', value: true });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sdk = (msg) => send({ type: 'sdk', msg });
    try {
      sdk({ type: 'system', subtype: 'init', session_id: 'mock', model: 'mock-model' });
      const say = async (t) => {
        sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } });
        sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'text' } } });
        for (const ch of t.match(/[\s\S]{1,6}/g)) { sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } } }); await sleep(25); }
        return t;
      };
      const fence = '`'.repeat(3);
      const t1 = await say(['ファイルを確認します。', '', fence + 'bash', 'cat README.md', fence, ''].join('\n'));
      sdk({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t1 }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat README.md' } }] } });
      const allowed = await new Promise((resolve) => {
        const id = crypto.randomUUID();
        pending.set(id, { resolve: (r) => resolve(r.behavior === 'allow'), suggestions: [], input: {} });
        send({ type: 'permission_request', id, toolName: 'Bash', input: { command: 'cat README.md' }, title: 'Claude は次のコマンドを実行します', hasSuggestions: true });
      });
      sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: allowed ? '# cdock\n(模擬の出力)' : '拒否されました', is_error: !allowed }] } });
      const t2 = await say(allowed ? ['**確認できました。** これは `cdock` の README です:', '', '- 項目1', '- 項目2', ''].join('\n') : '拒否されたので中止します。');
      sdk({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t2 }] } });
      sdk({ type: 'assistant', parent_tool_use_id: null, message: { content: [
        { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'src/app.js', old_string: 'const x = 1\nfunction hello() {', new_string: 'const x = 2\nconst y = 3\nfunction hello(name) {' } },
        { type: 'tool_use', id: 'tu3', name: 'Write', input: { file_path: 'notes.md', content: '# メモ\n\n- 追加した行' } }] } });
      sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }, { type: 'tool_result', tool_use_id: 'tu3', content: 'ok' }] } });
      sdk({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1500, total_cost_usd: 0.0123 });
    } finally { running = null; pending.clear(); send({ type: 'busy', value: false }); }
  }

  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'send' && typeof m.text === 'string' && m.text.trim()) runTurn(m);
    else if (m.type === 'permission') {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id);
      if (m.allow) p.resolve({ behavior: 'allow', updatedInput: p.input, ...(m.remember && p.suggestions ? { updatedPermissions: p.suggestions } : {}) });
      else p.resolve({ behavior: 'deny', message: 'ユーザーが拒否しました' });
    }
    else if (m.type === 'interrupt' && running) { try { await running.q.interrupt(); } catch { running.abort.abort(); } }
    else if (m.type === 'setMode' && running) { try { await running.q.setPermissionMode(m.mode); } catch {} }
    else if (m.type === 'newSession') { if (!running) sessionId = null; }
    else if (m.type === 'resume' && typeof m.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(m.sessionId) && !running) { sessionId = m.sessionId; }
  });
  ws.on('close', () => { if (running) running.abort.abort(); });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?t=${TOKEN}`;
  console.log(`cdock web  ${url}`);
  console.log(`作業フォルダ: ${DEFAULT_CWD}`);
});
