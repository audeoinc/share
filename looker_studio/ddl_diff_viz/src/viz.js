'use strict';
/**
 * ビジュアライゼーションの中核。DOM にも dscc にも依存しない純関数なので、
 * Looker Studio 上（src/index.js）と、ローカルプレビュー（scripts/preview.mjs）の
 * 両方から同じコードパスで呼べる。
 *
 * 入口は buildHtml(rows, style) -> HTML 文字列。
 */

const { splitLines, build2Way } = require('./lib/diff');
const { renderFragment2 } = require('./lib/render');

// LCS は O(n*m)。ブラウザ内で走るので上限を設けて、超えたら描画せず案内を出す。
const MAX_CELLS = 4000000; // 約 2000 行 x 2000 行
// 1 チャートに積む View 数の既定上限（style の maxViews で変更可）。
const DEFAULT_MAX_VIEWS = 10;

/** dscc の objectTransform は各フィールドを配列で返す（1 concept に複数フィールドを置けるため）。 */
function first(v) {
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  return v === undefined ? null : v;
}

function str(v) {
  const x = first(v);
  return x === null || x === undefined ? '' : String(x);
}

/**
 * style の値を取り出す。
 * カラー系は {color, opacity} オブジェクト、FONT_SIZE は "12px" のような文字列で来るため吸収する。
 * value が未設定なら defaultValue、それも無ければ fallback。
 */
function styleVal(style, id, fallback) {
  const e = style && style[id];
  if (!e) return fallback;
  let v = e.value;
  if (v === undefined || v === null || v === '') v = e.defaultValue;
  if (v && typeof v === 'object' && 'color' in v) v = v.color;
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

function numStyle(style, id, fallback) {
  const n = parseFloat(String(styleVal(style, id, fallback)));
  return isFinite(n) ? n : fallback;
}

/** style → render.js の configure() が受け取る opts に変換。 */
function toRenderOpts(style) {
  const fontFamily = styleVal(style, 'fontFamily', '');
  return {
    // 空文字なら render.js の既定（Roboto Mono 系）を使わせる
    fontFamily: fontFamily ? String(fontFamily) : undefined,
    fontSize: numStyle(style, 'fontSize', 12),
    lineHeight: numStyle(style, 'lineHeight', 1.35),
    colors: {
      baseColor: String(styleVal(style, 'baseColor', '#E17B7B')),
      afterColor: String(styleVal(style, 'afterColor', '#93AE68')),
    },
    diffLineOpacity: numStyle(style, 'diffLineOpacity', 0.3),
    diffCharOpacity: numStyle(style, 'diffCharOpacity', 0.55),
    syntax: {
      keyword: String(styleVal(style, 'syntaxKeyword', '#CF222E')),
      literal: String(styleVal(style, 'syntaxLiteral', '#098658')),
      comment: String(styleVal(style, 'syntaxComment', '#6E7781')),
    },
  };
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notice(text, kind) {
  const c = kind === 'warn'
    ? { bg: '#FFF8C5', border: '#D4A72C', fg: '#54470A' }
    : { bg: '#F6F8FA', border: '#D0D7DE', fg: '#57606A' };
  return (
    `<div style="margin:8px 0;padding:8px 12px;border:1px solid ${c.border};` +
    `border-left-width:4px;border-radius:4px;background:${c.bg};color:${c.fg};` +
    `font:13px/1.5 'Roboto','Segoe UI',system-ui,sans-serif">${esc(text)}</div>`
  );
}

/** View 名 + 増減行数の見出し（GitHub の Files changed ヘッダー相当）。 */
function viewHeader(label, diffRows) {
  let added = 0, deleted = 0;
  for (const r of diffRows) {
    if (r.left && r.left.kind === 'del') deleted++;
    if (r.right && r.right.kind === 'add') added++;
  }
  const badge = (txt, fg, bg) =>
    `<span style="display:inline-block;margin-left:8px;padding:1px 7px;border-radius:10px;` +
    `font:600 12px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;color:${fg};background:${bg}">${esc(txt)}</span>`;
  const same = added === 0 && deleted === 0;
  return (
    `<div style="margin:14px 0 6px;display:flex;align-items:center;flex-wrap:wrap">` +
    `<span style="font:600 13px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;color:#1A1A1A">${esc(label)}</span>` +
    (same ? badge('変更なし', '#57606A', '#EAEEF2')
          : badge('+' + added, '#1A7F37', '#DAFBE1') + badge('−' + deleted, '#B35900', '#FFEBE9')) +
    `</div>`
  );
}

/**
 * 1 View 分の差分 HTML。
 * before/after のどちらかが空（View の新規作成・削除）でも動く。
 */
function renderOne(beforeDdl, afterDdl, leftLabel, rightLabel, opts, showHeader, headerLabel) {
  const a = beforeDdl ? splitLines(beforeDdl) : [];
  const b = afterDdl ? splitLines(afterDdl) : [];

  if (a.length === 0 && b.length === 0) {
    return notice('DDL が空です。フィールドの割り当てを確認してください。');
  }
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return notice(
      `行数が多すぎるため差分計算を中止しました（${a.length} 行 × ${b.length} 行）。` +
      'BigQuery 側で事前に差分を取るか、対象を絞ってください。',
      'warn'
    );
  }

  const diffRows = build2Way(a, b);
  const head = showHeader ? viewHeader(headerLabel, diffRows) : '';
  return head + renderFragment2(leftLabel, rightLabel, diffRows, opts);
}

/**
 * dscc の objectTransform 形式の行配列を受け取り、innerHTML に流し込む HTML を返す。
 *
 * @param {Array<Object>} rows  data.tables.DEFAULT
 * @param {Object} style        data.style
 * @returns {string} HTML
 */
function buildHtml(rows, style) {
  const opts = toRenderOpts(style);
  const leftLabel = String(styleVal(style, 'leftLabel', 'before'));
  const rightLabel = String(styleVal(style, 'rightLabel', 'after'));
  const maxViews = Math.max(1, Math.round(numStyle(style, 'maxViews', DEFAULT_MAX_VIEWS)));

  if (!rows || rows.length === 0) {
    return notice('データがありません。「変更前 DDL」「変更後 DDL」にフィールドを割り当ててください。');
  }

  const shown = rows.slice(0, maxViews);
  const multi = rows.length > 1;
  let out = '';

  if (rows.length > maxViews) {
    out += notice(
      `${rows.length} 件のうち先頭 ${maxViews} 件を表示しています。` +
      'スタイル設定の「表示する View 数の上限」を上げるか、フィルタで絞り込んでください。',
      'warn'
    );
  }

  for (const row of shown) {
    const before = str(row.beforeDdl);
    const after = str(row.afterDdl);
    const key = str(row.viewKey);
    out += renderOne(
      before,
      after,
      leftLabel,
      rightLabel,
      opts,
      multi || key !== '',
      key || '(View 名フィールド未設定)'
    );
  }
  return out;
}

module.exports = { buildHtml, toRenderOpts, styleVal, MAX_CELLS };
