// vscode を模した部品で extension.js を動かし、中継 (fetch / WebSocket) が通るか確かめる。使い方: node test-host.js
const Module = require('module'); const path = require('path');
let handler = null; const cmds = {}; const posted = [];
const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u) => ({ toString: () => 'vscode-resource://x/' + path.basename(u.fsPath) }), set html(v) { this._h = v; }, get html() { return this._h; }, onDidReceiveMessage: (f) => { handler = f; }, postMessage: (m) => { posted.push(m); return Promise.resolve(true); } };
const vscode = {
  workspace: { onDidChangeWorkspaceFolders: () => ({ dispose() {} }), getWorkspaceFolder: () => null, workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: () => '' }) },
  window: { activeTextEditor: null, onDidChangeActiveTextEditor: () => ({ dispose() {} }), createOutputChannel: () => ({ appendLine: (s) => console.log('[srv]', s.slice(0, 120)), show() {} }), withProgress: (_o, f) => f(), showErrorMessage: (m) => console.log('ERR', m), createWebviewPanel: () => ({ webview: fakeWebview, reveal() {}, onDidDispose() {}, onDidChangeViewState() {} }) },
  commands: { registerCommand: (n, f) => { cmds[n] = f; return { dispose() {} }; } },
  extensions: { getExtension: () => null },
  ProgressLocation: { Notification: 15 }, ViewColumn: { Beside: -2 }, Uri: { file: (p) => ({ fsPath: p }) },
};
const orig = Module._load; Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
process.env.ELECTRON_RUN_AS_NODE = '1';
const ext = require('./extension.js'); const subs = [];
ext.activate({ extensionPath: __dirname, subscriptions: subs });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await cmds['crogue.open'](); await cmds['crogue.newPanel']();
  const h = fakeWebview.html; console.log('html:', h.includes('Content-Security-Policy'), h.includes('vscode-resource://x/app.js'), h.includes('acquireVsCodeApi'));
  handler({ t: 'fetch', id: 1, url: '/api/sessions?cwd=' + encodeURIComponent(process.cwd()), method: 'GET', headers: {} });
  handler({ t: 'ws-open', id: 2 });
  await wait(2500);
  const f = posted.find((m) => m.t === 'fetch-res'); console.log('fetch:', f && f.status, f && f.ctype, f && Buffer.from(f.body, 'base64').toString().slice(0, 80));
  const ws = posted.filter((m) => m.t === 'ws-msg').map((m) => JSON.parse(m.data).type); console.log('ws:', posted.some((m) => m.t === 'ws-open'), ws.join(','));
  handler({ t: 'ws-send', id: 2, data: JSON.stringify({ type: 'status_refresh' }) });
  ext.deactivate(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
