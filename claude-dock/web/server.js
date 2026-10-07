// cdock web — Claude Code をブラウザで使うローカル UI (Claude Agent SDK)
// 起動: node server.js [--port 8787] [--cwd <作業フォルダ>]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

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

async function api(url, res) {
  const cwd = resolveCwd(url.searchParams.get('cwd'));
  try {
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
  if (url.pathname.startsWith('/api/')) return api(url, res);
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
