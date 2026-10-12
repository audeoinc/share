// Claude Rogue の VS Code 拡張。画面 (server/public) と会話の処理 (server/server.js) は、単体版と同じものを使う。
// 拡張ホストが、server.js を 127.0.0.1 の空きポートで起動し、ウェブビューの fetch / WebSocket を、そこへ中継する。
const vscode = require('vscode');
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let proc = null, base = null, token = null, startPromise = null, out = null; const panels = new Set(); let activePanel = null;

function log(s) { if (!out) out = vscode.window.createOutputChannel('Claude Rogue'); out.appendLine(s); }

function startServer(ctx, cwd) {
  if (startPromise) return startPromise;
  startPromise = new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CDOCK_LIGHT: '1' };
    const cfg = vscode.workspace.getConfiguration('crogue').get('claudePath');
    const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'); // 公式のインストーラーの標準の場所
    env.CDOCK_CLAUDE_PATH = cfg || (fs.existsSync(local) ? local : 'auto'); // それ以外は、PATH から探す
    proc = cp.spawn(process.execPath, [path.join(ctx.extensionPath, 'server', 'server.js'), '--cwd', cwd], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', done = false;
    const onOut = (d) => {
      const s = d.toString(); log(s.trimEnd()); if (done) return; buf += s;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/.exec(buf);
      if (m) { done = true; base = `http://127.0.0.1:${m[1]}`; token = m[2]; resolve(); }
    };
    proc.stdout.on('data', onOut); proc.stderr.on('data', onOut);
    proc.on('error', (e) => { startPromise = null; reject(e); });
    proc.on('exit', (code) => { log(`サーバーが終了しました (${code})`); proc = null; startPromise = null; base = null; if (!done) reject(new Error(`サーバーを起動できませんでした (終了コード ${code})\n${buf.slice(-800)}`)); });
    setTimeout(() => { if (!done) reject(new Error('サーバーの起動が、時間内に終わりませんでした')); }, 30000);
  });
  return startPromise;
}
function stopServer() { if (proc) { try { proc.kill(); } catch { /* 無視 */ } } proc = null; startPromise = null; base = null; }

// ウェブビューの fetch を、サーバーへ中継する
function relayFetch(m, post) {
  const u = new URL(m.url, base); const body = m.body ? Buffer.from(m.body, 'base64') : null;
  const headers = { ...(m.headers || {}), Cookie: `cdock_t=${token}`, Origin: base };
  if (body) headers['content-length'] = body.length;
  const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: m.method || 'GET', headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => post({ t: 'fetch-res', id: m.id, status: res.statusCode, ctype: res.headers['content-type'] || '', body: Buffer.concat(chunks).toString('base64') }));
  });
  req.on('error', (e) => post({ t: 'fetch-res', id: m.id, status: 0, error: String(e.message || e) }));
  if (body) req.write(body);
  req.end();
}

function html(ctx, webview, cwd) {
  const dir = path.join(ctx.extensionPath, 'server', 'public');
  const uri = (f) => webview.asWebviewUri(vscode.Uri.file(path.join(dir, f))).toString();
  let s = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const nonce = crypto.randomBytes(16).toString('hex');
  const shim = fs.readFileSync(path.join(ctx.extensionPath, 'webview-shim.js'), 'utf8');
  s = s.replace(/href="icon\.png"/, `href="${uri('icon.png')}"`).replace(/src="icon\.png"/g, `src="${uri('icon.png')}"`)
    .replace('href="style.css"', `href="${uri('style.css')}"`).replace('src="app.js"', `nonce="${nonce}" src="${uri('app.js')}"`);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; frame-src blob:; media-src blob:; object-src blob:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}'; connect-src ${webview.cspSource};">`;
  // ファイル・Git・実行・プレビューは、VS Code のものを使うので、隠す
  const hide = '<style>#tab-files,#tab-git,#tab-run,#pane-files,#pane-git,#pane-run{display:none!important}</style>';
  return s.replace('<head>', `<head>${csp}${hide}<script nonce="${nonce}">window.__crogueCwd=${JSON.stringify(cwd || '')};${shim}</script>`);
}

function describePaths(uris) { // VS Code の URI (またはパス) を、添付の情報 (パス・名前・フォルダか) にする
  const items = [];
  for (const u of uris) {
    let p; try { p = typeof u === 'string' ? (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u) ? vscode.Uri.parse(u).fsPath : u) : u.fsPath; } catch { continue; }
    try { const st = fs.statSync(p); items.push({ path: p, name: path.basename(p) || p, isDir: st.isDirectory() }); } catch { /* 存在しないものは無視 */ }
  }
  return items;
}

// いまの作業フォルダ: 開いているファイルのワークスペースフォルダ (なければ、最初のフォルダ、それもなければホーム)
function currentFolder() {
  const ed = vscode.window.activeTextEditor; const wf = vscode.workspace.workspaceFolders || [];
  const f = ed && ed.document.uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(ed.document.uri) : null;
  return (f || wf[0] || { uri: { fsPath: os.homedir() } }).uri.fsPath;
}
async function gitRepoFor(dir) { // VS Code 標準の Git 拡張から、そのフォルダのリポジトリを得る
  try { const g = vscode.extensions.getExtension('vscode.git'); if (!g) return null; const api = (await g.activate()).getAPI(1); return api.getRepository(vscode.Uri.file(dir)); } catch { return null; }
}
function broadcast(msg) { for (const p of panels) p.webview.postMessage(msg); }
let lastCwdSent = '', gitSubs = [];
function followVsCode(ctx) { // VS Code のフォルダ・ブランチの変化を、会話の画面へ伝える
  const sendCwd = () => { const c = currentFolder(); if (c && c !== lastCwdSent) { lastCwdSent = c; broadcast({ t: 'cwd', path: c }); watchGit(c); } };
  const watchGit = async (dir, tries = 0) => {
    for (const d of gitSubs) d.dispose(); gitSubs = []; const repo = await gitRepoFor(dir);
    if (!repo) { if (tries < 5) setTimeout(() => watchGit(dir, tries + 1), 3000); return; } // 起動直後は、まだ見つからないことがある
    let tm = null; gitSubs.push(repo.state.onDidChange(() => { clearTimeout(tm); tm = setTimeout(() => broadcast({ t: 'git' }), 400); }));
  };
  lastCwdSent = currentFolder(); watchGit(lastCwdSent);
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(sendCwd), vscode.window.onDidChangeActiveTextEditor(sendCwd), { dispose: () => { for (const d of gitSubs) d.dispose(); } });
}

async function createPanel(ctx) {
  const cwd = currentFolder();
  try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Claude Rogue を起動しています…' }, () => startServer(ctx, cwd)); }
  catch (e) { const r = vscode.window.showErrorMessage(String(e.message || e), '出力を開く'); if (r && r.then) r.then((x) => { if (x && out) out.show(); }); return null; }
  const WebSocket = require('./server/node_modules/ws');
  const panel = vscode.window.createWebviewPanel('crogue', 'Claude Rogue', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'server', 'public'))] });
  panels.add(panel); activePanel = panel;
  const wv = panel.webview; const socks = new Map();
  wv.html = html(ctx, wv, cwd);
  wv.onDidReceiveMessage((m) => {
    const post = (x) => wv.postMessage(x);
    if (m.t === 'fetch') relayFetch(m, post);
    else if (m.t === 'ws-open') {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/ws`, { headers: { Cookie: `cdock_t=${token}`, Origin: base } }); socks.set(m.id, ws);
      ws.on('open', () => post({ t: 'ws-open', id: m.id }));
      ws.on('message', (d) => post({ t: 'ws-msg', id: m.id, data: d.toString() }));
      ws.on('close', () => { socks.delete(m.id); post({ t: 'ws-close', id: m.id }); });
      ws.on('error', (e) => log('ws: ' + e.message));
    } else if (m.t === 'ws-send') { const ws = socks.get(m.id); if (ws && ws.readyState === 1) ws.send(m.data); }
    else if (m.t === 'ws-close') { const ws = socks.get(m.id); if (ws) ws.close(); }
    else if (m.t === 'drop-uris') { const items = describePaths(m.uris || []); if (items.length) post({ t: 'attach', items }); }
  });
  panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) activePanel = e.webviewPanel; });
  panel.onDidDispose(() => { for (const w of socks.values()) w.close(); panels.delete(panel); if (activePanel === panel) activePanel = [...panels].pop() || null; });
  return panel;
}

async function openPanel(ctx, forceNew) {
  if (!forceNew && activePanel) { activePanel.reveal(); return activePanel; }
  return createPanel(ctx);
}

// エクスプローラーの右クリック「Claude Rogue に添付」: 開いている会話 (なければ新しく開く) の入力欄へ、元の場所のまま添付する
async function attachCommand(ctx, uri, uris) {
  const list = (uris && uris.length ? uris : uri ? [uri] : []);
  const items = describePaths(list); if (!items.length) return;
  const wasNew = !activePanel; const p = await openPanel(ctx, false); if (!p) return;
  if (wasNew) await new Promise((r) => setTimeout(r, 2500)); // 画面の読み込みを待つ
  p.webview.postMessage({ t: 'attach', items });
}

function activate(ctx) {
  followVsCode(ctx);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('crogue.open', () => openPanel(ctx, false)),
    vscode.commands.registerCommand('crogue.newPanel', () => openPanel(ctx, true)),
    vscode.commands.registerCommand('crogue.attach', (uri, uris) => attachCommand(ctx, uri, uris)),
    vscode.commands.registerCommand('crogue.restart', async () => { for (const p of [...panels]) p.dispose(); stopServer(); return openPanel(ctx, true); }),
    { dispose: stopServer },
  );
}
function deactivate() { stopServer(); }
module.exports = { activate, deactivate };
