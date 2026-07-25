'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { buildRows } = require('./src/align');
const {
  buildPanelHtml,
  buildStandaloneHtml,
  collectThemeVariables,
  escapeHtml,
} = require('./src/html');

/** 比較パネル（パネル -> セッション情報） */
const sessions = new Map();
/** HTML プレビューのパネル（パネル -> 表示中のファイル URI） */
const previews = new Map();
/** media 配下のテキストのキャッシュ */
const mediaCache = new Map();

function activate(context) {
  const register = (id, handler) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('multiFileDiff.compareSelected', (clicked, selected) =>
    run(context, clicked, selected, 'auto'));
  register('multiFileDiff.compareSelectedInPanel', (clicked, selected) =>
    run(context, clicked, selected, 'panel'));
  register('multiFileDiff.compareSelectedNative', (clicked, selected) =>
    run(context, clicked, selected, 'native'));
  register('multiFileDiff.previewHtml', (clicked) =>
    previewCommand(clicked).catch(reportError));

  // 表示中のファイルが保存されたら貼り直す
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      const key = document.uri.toString();
      for (const session of sessions.values()) {
        if (session.uris.some((uri) => uri.toString() === key)) {
          refresh(session).catch(reportError);
        }
      }
      for (const [panel, uri] of previews) {
        if (uri.toString() === key) renderPreview(panel, uri).catch(reportError);
      }
    })
  );
}

function deactivate() {
  sessions.clear();
  previews.clear();
  mediaCache.clear();
}

// ---------------------------------------------------------------------------
// 比較コマンド
// ---------------------------------------------------------------------------

async function run(context, clicked, selected, mode) {
  try {
    const uris = resolveUris(clicked, selected);
    if (uris.length < 2) {
      vscode.window.showWarningMessage(
        'ファイルを 2 つまたは 3 つ選択してから実行してください。（Ctrl キーを押しながらクリックで複数選択）'
      );
      return;
    }
    if (uris.length > 3) {
      vscode.window.showWarningMessage(
        `一度に比較できるのは 3 ファイルまでです。（${uris.length} 個選択されています）`
      );
      return;
    }

    const config = vscode.workspace.getConfiguration('multiFileDiff');
    const useNative =
      mode === 'native' ||
      (mode === 'auto' && uris.length === 2 && config.get('twoFileMode', 'native') === 'native');

    if (useNative) {
      await openNativeDiff(uris);
      return;
    }
    await openPanel(context, uris, config);
  } catch (error) {
    reportError(error);
  }
}

/**
 * エクスプローラーのコンテキストメニューは (クリックしたリソース, 選択中のリソース配列)
 * を渡してくる。コマンドパレットから呼ばれた場合は両方 undefined になる。
 */
function resolveUris(clicked, selected) {
  let uris = [];
  if (Array.isArray(selected) && selected.length > 0) {
    uris = selected.filter((uri) => uri instanceof vscode.Uri);
  } else if (clicked instanceof vscode.Uri) {
    uris = [clicked];
  }
  if (uris.length === 0) {
    // フォールバック: 開いているエディタのうち表示中のものを使う
    uris = vscode.window.visibleTextEditors.map((editor) => editor.document.uri);
  }
  const seen = new Set();
  return uris.filter((uri) => {
    const key = uri.toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** ネイティブの差分エディタで開く。3 ファイルなら 2 枚並べる。 */
async function openNativeDiff(uris) {
  await vscode.commands.executeCommand(
    'vscode.diff',
    uris[0],
    uris[1],
    `${labelOf(uris[0])} ↔ ${labelOf(uris[1])}`,
    { preview: false }
  );
  if (uris.length === 3) {
    await vscode.commands.executeCommand(
      'vscode.diff',
      uris[1],
      uris[2],
      `${labelOf(uris[1])} ↔ ${labelOf(uris[2])}`,
      { preview: false, viewColumn: vscode.ViewColumn.Beside }
    );
  }
}

// ---------------------------------------------------------------------------
// 比較パネル（Webview）
// ---------------------------------------------------------------------------

async function openPanel(context, uris, config) {
  const panel = vscode.window.createWebviewPanel(
    'multiFileDiff.compare',
    uris.map(labelOf).join(' ↔ '),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    }
  );

  const session = {
    panel,
    uris,
    extensionUri: context.extensionUri,
    options: {
      ignoreTrimWhitespace: config.get('ignoreTrimWhitespace', true),
      ignoreCase: config.get('ignoreCase', false),
      collapseUnchanged: config.get('collapseUnchanged', true),
      contextLines: config.get('contextLines', 3),
      wordWrap: config.get('wordWrap', false),
    },
    maxFileSizeKB: config.get('maxFileSizeKB', 4096),
  };
  sessions.set(panel, session);

  panel.onDidDispose(() => sessions.delete(panel), null, context.subscriptions);
  panel.webview.onDidReceiveMessage(
    (message) => handleMessage(context, session, message).catch(reportError),
    null,
    context.subscriptions
  );

  const nonce = crypto.randomBytes(16).toString('base64');
  panel.webview.html = buildPanelHtml({
    cspSource: panel.webview.cspSource,
    nonce,
    styleUri: panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'main.css')
    ),
    scriptUri: panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js')
    ),
  });
}

async function handleMessage(context, session, message) {
  switch (message.type) {
    case 'ready':
    case 'refresh':
      await refresh(session);
      break;
    case 'options':
      Object.assign(session.options, message.options);
      // 比較そのものに影響する設定なら計算し直す
      if ('ignoreTrimWhitespace' in message.options || 'ignoreCase' in message.options) {
        await refresh(session);
      }
      break;
    case 'open':
      await openAt(session.uris[message.file], message.line);
      break;
    case 'export':
      await exportHtml(context, session, message.data);
      break;
    default:
      break;
  }
}

async function refresh(session) {
  const { panel, uris, options } = session;
  panel.webview.postMessage({ type: 'busy' });
  try {
    const files = [];
    for (const uri of uris) {
      files.push(splitLines(await readTextFile(uri, session.maxFileSizeKB)));
    }
    const { rows, changedCount } = buildRows(files, {
      ignoreTrimWhitespace: options.ignoreTrimWhitespace,
      ignoreCase: options.ignoreCase,
    });

    panel.webview.postMessage({
      type: 'data',
      payload: {
        titles: uris.map((uri) => ({
          label: labelOf(uri),
          detail: vscode.workspace.asRelativePath(uri, false),
        })),
        lineCounts: files.map((lines) => lines.length),
        rows,
        changedCount,
        options,
        // HTML 出力時にテーマ色を固定するため、CSS が参照している変数名を渡す
        themeVars: collectThemeVariables(await readMedia(session.extensionUri, 'main.css')),
      },
    });
  } catch (error) {
    panel.webview.postMessage({ type: 'error', message: messageOf(error) });
  }
}

async function openAt(uri, line) {
  if (!uri) return;
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const target = Math.max(0, Math.min(document.lineCount - 1, (line || 1) - 1));
  const position = new vscode.Position(target, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

// ---------------------------------------------------------------------------
// HTML 出力
// ---------------------------------------------------------------------------

async function exportHtml(context, session, data) {
  const target = await vscode.window.showSaveDialog({
    title: '比較結果を HTML として保存',
    saveLabel: 'HTML を出力',
    defaultUri: defaultExportUri(session),
    filters: { HTML: ['html'] },
  });
  if (!target) {
    session.panel.webview.postMessage({ type: 'status', message: '出力を中止しました。' });
    return;
  }

  const html = buildStandaloneHtml({
    title: session.uris.map(labelOf).join(' ↔ '),
    css: await readMedia(session.extensionUri, 'main.css'),
    script: await readMedia(session.extensionUri, 'main.js'),
    themeVars: data.themeVars,
    payload: data.payload,
    expanded: data.expanded,
    exportedAt: new Date().toLocaleString('ja-JP'),
    sources: session.uris.map((uri) => vscode.workspace.asRelativePath(uri, false)),
  });

  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));
  session.panel.webview.postMessage({
    type: 'status',
    message: `${target.fsPath} に出力しました。`,
  });

  const config = vscode.workspace.getConfiguration('multiFileDiff');
  if (config.get('openPreviewAfterExport', true)) {
    await openPreview(context, target);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `HTML を出力しました: ${labelOf(target)}`,
    'プレビュー',
    'エディタで開く'
  );
  if (choice === 'プレビュー') await openPreview(context, target);
  else if (choice === 'エディタで開く') {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  }
}

function defaultExportUri(session) {
  const stem = session.uris
    .map((uri) => labelOf(uri).replace(/\.[^.]+$/, ''))
    .join('_vs_');
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const name = sanitizeFileName(`diff_${stem}_${stamp}.html`);

  const folder =
    (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri) ||
    vscode.Uri.joinPath(session.uris[0], '..');
  return vscode.Uri.joinPath(folder, name);
}

function sanitizeFileName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\s]/g, '_');
  return cleaned.length > 120 ? cleaned.slice(0, 110) + '.html' : cleaned;
}

// ---------------------------------------------------------------------------
// HTML プレビュー
// ---------------------------------------------------------------------------

async function previewCommand(clicked) {
  let uri = clicked instanceof vscode.Uri ? clicked : undefined;
  if (!uri && vscode.window.activeTextEditor) {
    uri = vscode.window.activeTextEditor.document.uri;
  }
  if (!uri) {
    vscode.window.showWarningMessage('プレビューする HTML ファイルを選択してください。');
    return;
  }
  await openPreview(null, uri);
}

async function openPreview(context, uri) {
  for (const [panel, current] of previews) {
    if (current.toString() === uri.toString()) {
      panel.reveal(panel.viewColumn);
      await renderPreview(panel, uri);
      return panel;
    }
  }

  const panel = vscode.window.createWebviewPanel(
    'multiFileDiff.preview',
    `プレビュー: ${labelOf(uri)}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: previewRoots(uri),
    }
  );
  previews.set(panel, uri);
  panel.onDidDispose(() => previews.delete(panel));
  if (context) context.subscriptions.push(panel);
  await renderPreview(panel, uri);
  return panel;
}

function previewRoots(uri) {
  const roots = [vscode.Uri.joinPath(uri, '..')];
  for (const folder of vscode.workspace.workspaceFolders || []) roots.push(folder.uri);
  return roots;
}

async function renderPreview(panel, uri) {
  try {
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString() && !document.isClosed
    );
    const html = open
      ? open.getText()
      : new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
    panel.webview.html = rewriteLocalUrls(panel.webview, vscode.Uri.joinPath(uri, '..'), html);
  } catch (error) {
    panel.webview.html =
      `<!DOCTYPE html><html lang="ja"><body style="font-family:sans-serif;padding:16px">` +
      `<p>プレビューできませんでした。</p><pre>${escapeHtml(messageOf(error))}</pre></body></html>`;
  }
}

/**
 * Webview からはワークスペースのファイルを直接参照できないので、
 * 相対パスの src / href を webview URI に置き換える。
 * 出力した HTML は自己完結しているので実際には何も書き換わらないが、
 * 手書きの HTML をプレビューするときに効いてくる。
 */
function rewriteLocalUrls(webview, baseUri, html) {
  return html.replace(
    /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (match, attribute, doubleQuoted, singleQuoted) => {
      const value = doubleQuoted !== undefined ? doubleQuoted : singleQuoted;
      if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value)) return match;
      try {
        const resolved = vscode.Uri.joinPath(baseUri, value);
        return `${attribute}="${webview.asWebviewUri(resolved)}"`;
      } catch {
        return match;
      }
    }
  );
}

// ---------------------------------------------------------------------------
// ファイル読み込み
// ---------------------------------------------------------------------------

async function readTextFile(uri, maxFileSizeKB) {
  // エディタで編集中（未保存）なら、その内容を優先する
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString() && !document.isClosed
  );
  if (open) return open.getText();

  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) {
    throw new Error(`フォルダーは比較できません: ${labelOf(uri)}`);
  }
  if (stat.size > maxFileSizeKB * 1024) {
    throw new Error(
      `${labelOf(uri)} が大きすぎます（${Math.round(stat.size / 1024)} KB / 上限 ${maxFileSizeKB} KB）。` +
        ' multiFileDiff.maxFileSizeKB で上限を変更できます。'
    );
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinary(bytes)) {
    throw new Error(`バイナリファイルは比較できません: ${labelOf(uri)}`);
  }
  // BOM は表示上のゴミになるので取り除く
  return new TextDecoder('utf-8').decode(bytes).replace(/\uFEFF/, '');
}

async function readMedia(extensionUri, name) {
  const key = `${extensionUri.toString()}/${name}`;
  if (!mediaCache.has(key)) {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(extensionUri, 'media', name)
    );
    mediaCache.set(key, new TextDecoder('utf-8').decode(bytes));
  }
  return mediaCache.get(key);
}

/** 先頭 8KB に NUL が含まれていればバイナリとみなす */
function looksBinary(bytes) {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

function labelOf(uri) {
  const index = uri.path.lastIndexOf('/');
  return index >= 0 ? uri.path.slice(index + 1) : uri.path;
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function reportError(error) {
  vscode.window.showErrorMessage(`Multi File Diff: ${messageOf(error)}`);
}

module.exports = { activate, deactivate };
