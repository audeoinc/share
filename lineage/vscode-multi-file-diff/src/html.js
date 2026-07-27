'use strict';

/*
 * Webview に流し込む HTML の組み立て。
 * vscode モジュールに依存しないので、単体でテストできる。
 *
 * パネル用と「HTML 出力」用で同じ本文マークアップを使うため、
 * 出力した HTML はパネルとまったく同じ見た目・操作感になる。
 */

/** パネル / 出力ファイル共通の本文マークアップ */
function bodyMarkup() {
  return `  <div class="toolbar">
    <div class="toolbar-left">
      <button id="btn-prev" class="tb" title="前の差分 (Shift+F7)">↑</button>
      <button id="btn-next" class="tb" title="次の差分 (F7)">↓</button>
      <span class="sep"></span>
      <button id="btn-collapse" class="tb toggle" title="一致している行を折りたたむ">変更箇所のみ</button>
      <button id="btn-wrap" class="tb toggle" title="長い行を折り返す">折り返し</button>
      <button id="btn-ws" class="tb toggle only-panel" title="行頭・行末の空白の違いを無視する">空白を無視</button>
      <button id="btn-case" class="tb toggle only-panel" title="大文字・小文字の違いを無視する">大小文字を無視</button>
      <span class="sep only-panel"></span>
      <button id="btn-refresh" class="tb only-panel" title="ファイルを読み直す">更新</button>
      <button id="btn-export" class="tb only-panel" title="この比較結果を単体で開ける HTML として保存する">HTML 出力</button>
    </div>
    <div class="toolbar-right"><span id="summary" class="summary"></span></div>
  </div>

  <div class="headers" id="headers"><div class="headers-inner" id="headers-inner"></div></div>

  <div class="body">
    <div class="viewport" id="viewport"><div class="grid" id="grid"></div></div>
    <div class="overview" id="overview" title="差分の位置"></div>
  </div>

  <div class="status" id="status"></div>`;
}

/**
 * 拡張機能のパネルに表示する HTML。CSS / JS は webview URI から読み込む。
 * @param {{cspSource: string, nonce: string, styleUri: string, scriptUri: string}} params
 */
function buildPanelHtml({ cspSource, nonce, styleUri, scriptUri }) {
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>Multi File Diff</title>
</head>
<body>
${bodyMarkup()}
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * 単体で開ける HTML。CSS / JS / 行データ / テーマ色をすべて埋め込むので、
 * VS Code の外（ブラウザ）で開いても同じ見た目になる。
 *
 * @param {{
 *   title: string,
 *   css: string,
 *   script: string,
 *   themeVars: Record<string, string>,
 *   payload: object,
 *   expanded?: string[],
 *   exportedAt: string,
 *   sources?: string[]
 * }} params
 */
function buildStandaloneHtml(params) {
  const { title, css, script, themeVars, payload, expanded, exportedAt, sources } = params;

  const vars = Object.keys(themeVars || {})
    .sort()
    .map((name) => `  ${name}: ${String(themeVars[name]).replace(/[;{}<]/g, '')};`)
    .join('\n');

  const data = embedJson({
    payload,
    expanded: expanded || [],
    exportedAt,
    sources: sources || [],
  });

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
/* 出力時の VS Code テーマの色をそのまま固定している */
:root {
${vars}
}
</style>
<style>
${sanitizeStyle(css)}
</style>
</head>
<body class="standalone">
${bodyMarkup()}
  <script>window.__MFD_EXPORT__ = ${data};</script>
  <script>
${sanitizeScript(script)}
  </script>
</body>
</html>`;
}

function embedJson(value) {
  // < は </script> の誤検出を、U+2028/U+2029 は JS の行終端扱いを避けるためエスケープする
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** インライン化したときに <script> ブロックを閉じてしまわないようにする */
function sanitizeScript(source) {
  return String(source).replace(/<\/script/gi, '<\\/script');
}

function sanitizeStyle(source) {
  return String(source).replace(/<\/style/gi, '<\\/style');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** CSS 中で参照しているテーマ変数名を洗い出す（出力時に値を固定するため） */
function collectThemeVariables(css) {
  const names = String(css).match(/--vscode-[A-Za-z0-9-]+/g) || [];
  return Array.from(new Set(names)).sort();
}

module.exports = {
  bodyMarkup,
  buildPanelHtml,
  buildStandaloneHtml,
  collectThemeVariables,
  escapeHtml,
};
