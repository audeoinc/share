'use strict';
/**
 * ビジュアライゼーションの中核。DOM にも dscc にも依存しない純関数なので、
 * Looker Studio 上（src/index.js）と、ローカルプレビュー（scripts/preview.mjs）の
 * 両方から同じコードパスで呼べる。
 *
 * 入口は buildHtml(rows, style) -> HTML 文字列。
 *
 * データモデル: BigQuery 側は (key, ddl) の 2 列だけ。
 * レポートのフィルタ操作で key を 2 つ選ぶと、この 2 行が渡ってくるので突き合わせる。
 */

const { splitLines, build2Way } = require('./lib/diff');
const { renderFragment2 } = require('./lib/render');

// LCS は O(n*m)。ブラウザ内で走るので上限を設けて、超えたら描画せず案内を出す。
const MAX_CELLS = 4000000; // 約 2000 行 x 2000 行

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

function boolStyle(style, id, fallback) {
  const v = styleVal(style, id, fallback);
  return v === true || v === 'true';
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

/**
 * Looker Studio が実際に何を渡してきたかを画面に出す。
 * デプロイ先の中を覗けないので、切り分けはこれを見て行う。
 */
function debugBlock(rows, style, picked) {
  const lines = [];
  lines.push(`rows: ${rows ? rows.length : 'null'}`);
  if (rows && rows.length > 0) {
    lines.push(`1 行目のフィールド id: [${Object.keys(rows[0]).join(', ')}]`);
    rows.slice(0, 10).forEach((r, i) => {
      lines.push(
        `  [${i}] key=${JSON.stringify(first(r.key))} ` +
        `ddl=${str(r.ddl).length} 文字 ` +
        `ddl先頭=${JSON.stringify(str(r.ddl).slice(0, 40))}`
      );
    });
    if (rows.length > 10) lines.push(`  … 他 ${rows.length - 10} 行`);
  }
  lines.push(`style で受け取った id: [${Object.keys(style || {}).join(', ')}]`);
  if (picked) {
    lines.push(
      `解決結果: before=${JSON.stringify(picked.before && picked.before.key)} ` +
      `after=${JSON.stringify(picked.after && picked.after.key)}`
    );
  }
  return (
    `<pre style="margin:8px 0;padding:8px 12px;border:1px solid #8250DF;` +
    `border-left-width:4px;border-radius:4px;background:#FBF7FF;color:#3B2A57;` +
    `font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;` +
    `white-space:pre-wrap;word-break:break-all">${esc(lines.join('\n'))}</pre>`
  );
}

/** 増減行数のバッジ（GitHub の Files changed ヘッダー相当）。 */
function summaryHeader(diffRows) {
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
    `<div style="margin:10px 0 6px;display:flex;align-items:center;flex-wrap:wrap">` +
    `<span style="font:600 13px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;color:#1A1A1A">差分</span>` +
    (same ? badge('変更なし', '#57606A', '#EAEEF2')
          : badge('+' + added, '#1A7F37', '#DAFBE1') + badge('−' + deleted, '#B35900', '#FFEBE9')) +
    `</div>`
  );
}

/**
 * 渡された行から比較する 2 件を決める。
 *
 * - スタイル設定で「変更前の key」「変更後の key」が指定されていれば、それを完全一致で探す
 * - 未指定の側は、まだ使っていない行を先頭から詰める
 * - 「左右を入れ替え」がオンなら最後に入れ替える
 *
 * @returns {{before: Object|null, after: Object|null, warnings: string[]}}
 */
function pickPair(rows, style) {
  const items = rows.map((r) => ({ key: str(r.key), ddl: str(r.ddl) }));
  const wantBefore = String(styleVal(style, 'beforeKey', '')).trim();
  const wantAfter = String(styleVal(style, 'afterKey', '')).trim();
  const warnings = [];

  const findIdx = (k) => items.findIndex((i) => i.key === k);

  const usedIdx = new Set();
  let beforeIdx = -1, afterIdx = -1;

  if (wantBefore) {
    beforeIdx = findIdx(wantBefore);
    if (beforeIdx < 0) warnings.push(`「変更前の key」に指定された "${wantBefore}" が見つかりません。`);
    else usedIdx.add(beforeIdx);
  }
  if (wantAfter) {
    afterIdx = findIdx(wantAfter);
    if (afterIdx < 0) warnings.push(`「変更後の key」に指定された "${wantAfter}" が見つかりません。`);
    else if (afterIdx === beforeIdx) {
      warnings.push('「変更前の key」と「変更後の key」に同じ値が指定されています。');
      afterIdx = -1;
    } else usedIdx.add(afterIdx);
  }

  // 未指定・未解決の側を、まだ使っていない行で先頭から埋める
  for (let i = 0; i < items.length; i++) {
    if (usedIdx.has(i)) continue;
    if (beforeIdx < 0) { beforeIdx = i; usedIdx.add(i); continue; }
    if (afterIdx < 0) { afterIdx = i; usedIdx.add(i); continue; }
    break;
  }

  let before = beforeIdx >= 0 ? items[beforeIdx] : null;
  let after = afterIdx >= 0 ? items[afterIdx] : null;

  if (boolStyle(style, 'swap', false)) {
    const t = before; before = after; after = t;
  }
  return { before, after, warnings, total: items.length };
}

/**
 * dscc の objectTransform 形式の行配列（key, ddl の 2 列）を受け取り、
 * innerHTML に流し込む HTML を返す。
 *
 * @param {Array<Object>} rows  data.tables.DEFAULT
 * @param {Object} style        data.style
 * @returns {string} HTML
 */
function buildHtml(rows, style) {
  const debug = boolStyle(style, 'debug', false);

  if (!rows || rows.length === 0) {
    return (
      (debug ? debugBlock(rows, style, null) : '') +
      notice(
        'Looker Studio から 1 行もデータが渡ってきていません。' +
        '(1) 「key」「DDL」にフィールドを割り当てたか (2) データソース自体にデータがあるか ' +
        '(3) メトリクス欄に Record Count を割り当てると返るか、を順に確認してください。',
        'warn'
      )
    );
  }

  // 期待するフィールド id が来ていない = config が古い可能性が高い
  const keys = Object.keys(rows[0]);
  if (!keys.includes('key') || !keys.includes('ddl')) {
    return (
      debugBlock(rows, style, null) +
      notice(
        `フィールド id が想定と違います（受け取ったのは [${keys.join(', ')}]、期待するのは key と ddl）。` +
        'GCS の index.json が古いままの可能性があります。再アップロードし、' +
        'index.js / index.json のキャッシュ設定を確認してください。',
        'warn'
      )
    );
  }

  const picked = pickPair(rows, style);
  const { before, after, warnings, total } = picked;
  let out = (debug ? debugBlock(rows, style, picked) : '') +
    warnings.map((w) => notice(w, 'warn')).join('');

  if (!before || !after) {
    return out + notice(
      `比較対象が ${total} 件しかありません。フィルタ操作（プルダウン）で key を 2 つ選択してください。`,
      'warn'
    );
  }
  if (total > 2) {
    out += notice(
      `key が ${total} 件選択されています。"${before.key}" と "${after.key}" を比較しています。` +
      '対象を変えるにはフィルタで 2 件に絞るか、スタイル設定で key を明示してください。',
      'warn'
    );
  }

  const a = before.ddl ? splitLines(before.ddl) : [];
  const b = after.ddl ? splitLines(after.ddl) : [];

  if (a.length === 0 && b.length === 0) {
    return out + notice('DDL が空です。フィールドの割り当てを確認してください。');
  }
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return out + notice(
      `行数が多すぎるため差分計算を中止しました（${a.length} 行 × ${b.length} 行）。`,
      'warn'
    );
  }

  const opts = toRenderOpts(style);
  const diffRows = build2Way(a, b);
  // ペイン見出しには key をそのまま出す。render.js 側が 2 つの見出しの
  // 差異部分（日付など）をハイライトしてくれる。
  return out + summaryHeader(diffRows) + renderFragment2(before.key, after.key, diffRows, opts);
}

module.exports = { buildHtml, pickPair, toRenderOpts, styleVal, MAX_CELLS };
