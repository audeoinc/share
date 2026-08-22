'use strict';
const { nameDiff } = require('./diff');
/**
 * 差分データ → Confluence 貼り付け用 HTML フラグメント。
 * 方針（PRD R3 / D3 / D4）:
 *  - <!DOCTYPE>/<html>/<head>/<body> を含まない「部品」。ルートは <div>。
 *  - すべてのスタイルは各要素の style 属性にインライン（外部CSS/クラス非依存）。
 *  - Material Design ベース（ライト）。SQL シンタックスハイライト対応。
 *  - ペインごとにアクセント色: base=Blue / after=Green / reference=Purple。
 *  - 差分の空きセルは VS Code 風の斜線ハッチ。
 *  - コードは white-space:pre-wrap（インデント保持のまま画面幅で折り返し）。
 */

// 既定のフォント（設定 fontFamily の既定値としても使う）
const DEFAULT_FONT = "'Roboto Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

// 既定値。VS Code の設定（extension.js 経由）で configure() により上書きできる。
const DEFAULTS = {
  T: {
    font: DEFAULT_FONT,
    headFont: "'Roboto','Segoe UI',system-ui,-apple-system,sans-serif",
    fontSize: 12,
    lineHeight: 1.35,
    text: '#24292F',            // 本文（しっかりした濃色）
    title: '#1A1A1A',           // ヘッダのファイル名（全ペイン黒め）
    num: '#B0BAC5',
    numBorder: '#ECEFF1', border: '#E0E0E0', headSub: '#90A4AE',
    emptyBg: '#FAFAFA',
    shadow: '0 1px 3px rgba(0,0,0,.10),0 1px 2px rgba(0,0,0,.18)',
    hatch: 'background-color:#FAFAFA;background-image:repeating-linear-gradient(45deg,rgba(120,130,140,.10),rgba(120,130,140,.10) 3px,transparent 3px,transparent 7px);',
  },
  // 各ペインの「基本色」1色。差分行/文字/バー/マーカー/ヘッダ を透過度で導出する。
  paneColors: { base: '#E17B7B', after: '#93AE68', ref: '#7E9BC8' }, // 赤 / 緑 / 青
  lineOpacity: 0.30, // 差分行の背景の濃さ（低いほど淡い）
  charOpacity: 0.55, // 差分文字（行内ハイライト）の濃さ
  // SQL シンタックス色（予約語=赤 / リテラル=緑 / コメント=グレー）
  S: { keyword: '#CF222E', literal: '#098658', comment: '#6E7781' },
  fontFamily: DEFAULT_FONT,
};

// 現在有効な設定（configure() で毎回 DEFAULTS から作り直す）
let T = { ...DEFAULTS.T };
let PANES;
let S = { ...DEFAULTS.S };

function isNum(v) { return typeof v === 'number' && isFinite(v); }
const HEX = /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function toHex(r, g, b) { const c = (v) => ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); return '#' + c(r) + c(g) + c(b); }
function mixWhite(hex, a) { const [r, g, b] = hexToRgb(hex); const m = (v) => 255 + (v - 255) * a; return toHex(m(r), m(g), m(b)); }
function darken(hex, amt) { const [r, g, b] = hexToRgb(hex); const d = (v) => v * (1 - amt); return toHex(d(r), d(g), d(b)); }

/** ペイン1色 → 差分行/文字/バー/マーカー/行番号/ヘッダ を導出（補助色が基本色に追従する） */
function buildPane(color, lineOp, charOp) {
  return {
    bg: mixWhite(color, lineOp),   // 差分行の背景
    hi: mixWhite(color, charOp),   // 差分文字（行内ハイライト）
    bar: color,                    // 左のカラーバー（基本色そのもの）
    mark: darken(color, 0.28),     // +/- マーカー
    numBg: mixWhite(color, 0.05),  // 行番号列のティント
    headText: darken(color, 0.40), // ヘッダのサブラベル
    headBg: mixWhite(color, 0.14), // ヘッダ背景
  };
}

/** VS Code 設定などによる上書き。未指定の項目は既定値のまま。 */
function configure(opts) {
  T = { ...DEFAULTS.T };
  S = { ...DEFAULTS.S };
  const pc = { ...DEFAULTS.paneColors };
  let lineOp = DEFAULTS.lineOpacity, charOp = DEFAULTS.charOpacity;
  if (opts) {
    if (opts.fontFamily) T.font = opts.fontFamily;
    if (isNum(opts.fontSize)) T.fontSize = opts.fontSize;
    if (isNum(opts.lineHeight)) T.lineHeight = opts.lineHeight;
    const c = opts.colors || {};
    if (HEX.test(c.baseColor || '')) pc.base = c.baseColor;
    if (HEX.test(c.afterColor || '')) pc.after = c.afterColor;
    if (HEX.test(c.refColor || '')) pc.ref = c.refColor;
    if (isNum(opts.diffLineOpacity)) lineOp = opts.diffLineOpacity;
    if (isNum(opts.diffCharOpacity)) charOp = opts.diffCharOpacity;
    const s = opts.syntax || {};
    if (s.keyword) S.keyword = s.keyword;
    if (s.literal) S.literal = s.literal;
    if (s.comment) S.comment = s.comment;
  }
  PANES = {
    base: buildPane(pc.base, lineOp, charOp),
    after: buildPane(pc.after, lineOp, charOp),
    ref: buildPane(pc.ref, lineOp, charOp),
  };
}

configure(); // 既定で初期化

const SQL_KEYWORDS = new Set(('SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING ' +
  'AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME ' +
  'GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH FIRST NEXT ONLY ROWS ' +
  'UNION INTERSECT EXCEPT DISTINCT AS CASE WHEN THEN ELSE END ' +
  'INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX ' +
  'WITH RECURSIVE OVER PARTITION ROW_NUMBER RANK DENSE_RANK ' +
  'INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC VARCHAR CHAR TEXT DATE TIMESTAMP BOOLEAN ' +
  'PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT CASCADE ' +
  'TRUE FALSE COUNT SUM AVG MIN MAX COALESCE CAST').split(/\s+/));

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** SQL の簡易シンタックスハイライト */
function sqlHighlight(src) {
  const n = src.length;
  let i = 0, out = '';
  const span = (color, text, italic) =>
    `<span style="color:${color};${italic ? 'font-style:italic;' : ''}">${esc(text)}</span>`;
  const isWS = (c) => c === ' ' || c === '\t';
  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[A-Za-z_]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_]/.test(c);
  const isOp = (c) => '=<>!+-*/%|,.();:'.indexOf(c) >= 0;

  while (i < n) {
    const ch = src[i];
    if (isWS(ch)) { let j = i + 1; while (j < n && isWS(src[j])) j++; out += esc(src.slice(i, j)); i = j; continue; }
    // コメント
    if (ch === '-' && src[i + 1] === '-') { out += span(S.comment, src.slice(i), true); break; }
    // 文字列リテラル
    if (ch === "'") {
      let j = i + 1;
      while (j < n) { if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; } j++; }
      out += span(S.literal, src.slice(i, j)); i = j; continue;
    }
    // 数値リテラル
    if (isDigit(ch)) { let j = i + 1; while (j < n && (isDigit(src[j]) || src[j] === '.')) j++; out += span(S.literal, src.slice(i, j)); i = j; continue; }
    // 予約語 / 識別子
    if (isIdentStart(ch)) {
      let j = i + 1; while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      if (SQL_KEYWORDS.has(word.toUpperCase())) out += span(S.keyword, word);
      else out += esc(word); // 識別子・関数は本文色（既定）
      i = j; continue;
    }
    // 演算子・記号は本文色
    out += esc(ch); i++;
  }
  return out;
}

function renderSegs(segs, hiColor) {
  if (!segs || !segs.length) return '&nbsp;';
  let out = '';
  for (const seg of segs) {
    const inner = sqlHighlight(seg.text);
    out += seg.hi ? `<span style="background:${hiColor};border-radius:2px;">${inner}</span>` : inner;
  }
  return out === '' ? '&nbsp;' : out;
}

function numTd(num, pane, leftBorder) {
  const lb = leftBorder ? `border-left:1px solid ${T.border};` : '';
  return `<td style="padding:0 10px;text-align:right;color:${T.num};background:${pane.numBg};border-right:1px solid ${T.numBorder};${lb}white-space:nowrap;">${num == null ? '&nbsp;' : num}</td>`;
}

function markTd(kind, pane) {
  if (kind === 'add') return `<td style="padding:0 4px;text-align:center;color:${pane.mark};">+</td>`;
  if (kind === 'del') return `<td style="padding:0 4px;text-align:center;color:${pane.mark};">−</td>`;
  return `<td style="padding:0 4px;text-align:center;color:${T.headSub};">&nbsp;</td>`;
}

function codeTd(kind, html, pane) {
  let s = `padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere;color:${T.text};`;
  if (kind === 'add' || kind === 'del' || kind === 'diff') s += `background:${pane.bg};border-left:2px solid ${pane.bar};`;
  return `<td style="${s}">${html || '&nbsp;'}</td>`;
}

// 削除/空きセル（斜線ハッチ）
function hatchTd(kind, leftBorder) {
  const lb = leftBorder ? `border-left:1px solid ${T.border};` : '';
  if (kind === 'num') return `<td style="padding:0 10px;border-right:1px solid ${T.numBorder};${lb}${T.hatch}">&nbsp;</td>`;
  if (kind === 'mark') return `<td style="padding:0 4px;${T.hatch}">&nbsp;</td>`;
  return `<td style="padding:0 12px;white-space:pre-wrap;${lb}${T.hatch}">&nbsp;</td>`;
}

// ファイル名セグメント（[{text,hi}]）を、差分部分だけ pane.hi でハイライトして描画
function labelHtml(segs, pane) {
  if (typeof segs === 'string') segs = [{ text: segs, hi: false }];
  return segs.map((s) => s.hi
    ? `<span style="background:${pane.hi};border-radius:2px;">${esc(s.text)}</span>`
    : esc(s.text)).join('');
}

function th(colspan, labelSegs, sub, pane, leftBorder) {
  const lb = leftBorder ? `border-left:1px solid ${T.border};` : '';
  const subHtml = sub ? `&nbsp;<span style="color:${pane.headText};font-weight:400;">(${esc(sub)})</span>` : '';
  // ファイル名は全ペイン黒め、差分部分のみペイン色でハイライト、サブラベルはペイン色
  return `<th colspan="${colspan}" style="text-align:left;font-family:${T.headFont};font-weight:600;color:${T.title};background:${pane.headBg};border-bottom:2px solid ${pane.bar};${lb}padding:7px 12px;">${labelHtml(labelSegs, pane)}${subHtml}</th>`;
}

function wrapTable(colgroup, theadHtml, bodyHtml) {
  return (
    `<div style="font-family:${T.font};color:${T.text};line-height:${T.lineHeight};-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%;">\n` +
    `  <table style="border-collapse:collapse;border:1px solid ${T.border};border-radius:4px;overflow:hidden;font-size:${T.fontSize}px;background:#ffffff;width:100%;max-width:100%;table-layout:fixed;box-shadow:${T.shadow};-webkit-text-size-adjust:100%;text-size-adjust:100%;">\n` +
    `    ${colgroup}\n` +
    `    <thead><tr>${theadHtml}</tr></thead>\n` +
    `    <tbody>\n${bodyHtml}    </tbody>\n` +
    `  </table>\n` +
    `</div>\n`
  );
}

/**
 * 1-way フラグメント（1 ペインだけ）。比較する相手がいないとき用。
 * 同じ SQL を左右に並べても読む人が得るものが無いので、そのまま 1 枚で出す。
 * 差分の色分け（+/− マーカー・行背景）は出番が無いので付けない。
 */
function renderFragment1(label, sub, lines, opts) {
  configure(opts);
  const colgroup = '<colgroup><col style="width:40px"><col></colgroup>';
  const thead = th(2, label, sub, PANES.after, false);
  let body = '';
  for (let i = 0; i < lines.length; i++) {
    body += `      <tr>${numTd(i + 1, PANES.after, false)}` +
      `${codeTd('same', sqlHighlight(lines[i]), PANES.after)}</tr>\n`;
  }
  return wrapTable(colgroup, thead, body);
}

/** 2-way フラグメント（左=base / 右=after）。各ペイン等幅（table-layout:fixed） */
function renderFragment2(leftLabel, rightLabel, rows, opts) {
  configure(opts);
  const colgroup =
    '<colgroup>' +
    `<col style="width:40px"><col style="width:22px"><col>` +
    `<col style="width:40px"><col style="width:22px"><col>` +
    '</colgroup>';
  const nd = nameDiff([leftLabel, rightLabel]);
  const thead = th(3, nd[0], 'before', PANES.base, false) + th(3, nd[1], 'after', PANES.after, true);
  let body = '';
  for (const r of rows) {
    const L = r.left, R = r.right;
    let cells = '';
    if (L) cells += numTd(L.num, PANES.base, false) + markTd(L.kind === 'del' ? 'del' : 'blank', PANES.base) + codeTd(L.kind, renderSegs(L.segs, PANES.base.hi), PANES.base);
    else cells += hatchTd('num', false) + hatchTd('mark', false) + hatchTd('code', false);
    if (R) cells += numTd(R.num, PANES.after, true) + markTd(R.kind === 'add' ? 'add' : 'blank', PANES.after) + codeTd(R.kind, renderSegs(R.segs, PANES.after.hi), PANES.after);
    else cells += hatchTd('num', true) + hatchTd('mark', true) + hatchTd('code', true);
    body += `      <tr>${cells}</tr>\n`;
  }
  return wrapTable(colgroup, thead, body);
}

/** 3-way フラグメント（base / after / reference, 基準=左端 base）。各ペイン等幅 */
function renderFragment3(labels, rows, opts) {
  configure(opts);
  const panes = [PANES.base, PANES.after, PANES.ref];
  const colgroup =
    '<colgroup>' +
    `<col style="width:40px"><col>` +
    `<col style="width:40px"><col>` +
    `<col style="width:40px"><col>` +
    '</colgroup>';
  const nd = nameDiff(labels);
  const thead =
    th(2, nd[0], 'base', PANES.base, false) +
    th(2, nd[1], 'after', PANES.after, true) +
    th(2, nd[2], 'reference', PANES.ref, true);
  const counters = [0, 0, 0];
  let body = '';
  for (const r of rows) {
    const cells = [r.c1, r.c2, r.c3];
    let html = '';
    for (let ci = 0; ci < 3; ci++) {
      const cell = cells[ci];
      const P = panes[ci];
      if (cell.kind === 'empty') {
        html += hatchTd('num', ci > 0) + hatchTd('code', ci > 0);
      } else {
        const num = ++counters[ci];
        html += numTd(num, P, ci > 0) + codeTd(cell.kind === 'base' ? 'plain' : cell.kind, renderSegs(cell.segs, P.hi), P);
      }
    }
    body += `      <tr>${html}</tr>\n`;
  }
  return wrapTable(colgroup, thead, body);
}

module.exports = { renderFragment1, renderFragment2, renderFragment3, configure, esc, sqlHighlight, DEFAULTS };
