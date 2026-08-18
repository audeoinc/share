-- =====================================================================
-- DIFF_HTML — 2 つの DDL から差分 HTML（インライン CSS の自己完結フラグメント）を返す
--
-- Looker Studio のコミュニティ ビジュアライゼーション "Templated Record" に
-- HTML 文字列のカラムを渡して描画させるための UDF。
-- Templated Record はギャラリー掲載品なので公開元がホストしており、
-- こちらで GCS バケットを公開する必要がない。
--
-- ※ このファイルは build_udf.mjs が生成する。直接編集しないこと。
--    元コードは diff_html/ の VS Code 拡張の lib/diff.js / lib/render.js。
--    再生成: node looker_studio/templated_record/build_udf.mjs
--
-- 引数:
--   before_ddl    変更前の DDL
--   after_ddl     変更後の DDL
--   left_label    左ペインの見出し（NULL なら 'before'）
--   right_label   右ペインの見出し（NULL なら 'after'）
--   options_json  表示オプション。NULL または '{}' で既定。例:
--                   {"contextLines": 3}        変更行の前後 3 行だけ描画（HTML を小さくする）
--                   {"fontSize": 12, "lineHeight": 1.35}
--                   {"colors": {"baseColor": "#E17B7B", "afterColor": "#93AE68"}}
--                   {"diffLineOpacity": 0.30, "diffCharOpacity": 0.55}
--                   {"syntax": {"keyword": "#CF222E", "literal": "#098658", "comment": "#6E7781"}}
--
-- PROJECT / DATASET は自分の環境に置換すること。
-- =====================================================================
CREATE OR REPLACE FUNCTION `PROJECT.DATASET.DIFF_HTML`(
  before_ddl   STRING,
  after_ddl    STRING,
  left_label   STRING,
  right_label  STRING,
  options_json STRING
)
RETURNS STRING
LANGUAGE js AS r"""
/**
 * 依存ゼロの差分ロジック（Q2 の決定: 自前計算・LCS ベース）。
 * - diffLines: 2つの行配列の LCS 差分
 * - wordDiff : 変更行の行内（トークン単位）差分
 * - build2Way: サイドバイサイド用の行データ
 * - build3Way: 3ペイン（基準=左端）用の行データ
 *
 * ※ LCS は O(n*m) の DP。社内 SQL レビュー規模を想定した実装。
 *    極端に巨大なファイルは将来（Phase 1+）で分割/Myers 化を検討。
 */

/** 行単位 LCS 差分。ops: {type:'equal'|'del'|'add', aIndex?, bIndex?, text} */
function diffLines(a, b) {
  const n = a.length, m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'equal', aIndex: i, bIndex: j, text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', aIndex: i, text: a[i] }); i++; }
    else { ops.push({ type: 'add', bIndex: j, text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', aIndex: i, text: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', bIndex: j, text: b[j] }); j++; }
  return ops;
}

/** base トークンが target の LCS に含まれる（=一致）かのフラグ配列 */
function lcsMatchFlags(a, b) {
  const n = a.length, m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const flags = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { flags[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { i++; }
    else { j++; }
  }
  return flags;
}

/** トークン分割（語 / 空白 / 記号）。行内差分用。 */
function tokenize(s) {
  return s.match(/([A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_])/g) || [];
}

/** 隣り合う同フラグのセグメントを結合 */
function mergeSegs(segs) {
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.hi === seg.hi) last.text += seg.text;
    else out.push({ text: seg.text, hi: seg.hi });
  }
  return out;
}

/** 与えられたトークン列 A(old)/B(new) の差分セグメントを返す。 */
function segDiff(A, B) {
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const oldSegs = [], newSegs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { oldSegs.push({ text: A[i], hi: false }); newSegs.push({ text: B[j], hi: false }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { oldSegs.push({ text: A[i], hi: true }); i++; }
    else { newSegs.push({ text: B[j], hi: true }); j++; }
  }
  while (i < n) { oldSegs.push({ text: A[i], hi: true }); i++; }
  while (j < m) { newSegs.push({ text: B[j], hi: true }); j++; }
  return { oldSegs: mergeSegs(oldSegs), newSegs: mergeSegs(newSegs) };
}

/** 行内差分。old/new それぞれのハイライト用セグメントを返す。 */
function wordDiff(oldStr, newStr) {
  return segDiff(tokenize(oldStr), tokenize(newStr));
}

/** ファイル名用トークン分割（区切り記号 _ . - を境界にする）。 */
function tokenizeName(s) {
  return String(s).match(/([^._\-\s]+|[._\-\s])/g) || [];
}

/**
 * ヘッダのファイル名ハイライト。names の各要素に対し、他と異なる部分を hi にする。
 * 返り値: names と同じ長さの配列。各要素は [{text, hi}] のセグメント列。
 * 2件: 互いの差分。3件: base(先頭)基準で after/ref を強調、base は「いずれかと違う部分」を強調。
 */
function nameDiff(names) {
  if (!Array.isArray(names) || names.length < 2) {
    return (names || []).map((n) => [{ text: String(n), hi: false }]);
  }
  if (names.length === 2) {
    const d = segDiff(tokenizeName(names[0]), tokenizeName(names[1]));
    return [d.oldSegs, d.newSegs];
  }
  const baseToks = tokenizeName(names[0]);
  const afterToks = tokenizeName(names[1]);
  const refToks = tokenizeName(names[2]);
  const afterSegs = segDiff(baseToks, afterToks).newSegs;
  const refSegs = segDiff(baseToks, refToks).newSegs;
  const matchedAll = new Array(baseToks.length).fill(true);
  for (const tgt of [afterToks, refToks]) {
    const m = lcsMatchFlags(baseToks, tgt);
    for (let i = 0; i < baseToks.length; i++) matchedAll[i] = matchedAll[i] && m[i];
  }
  const baseSegs = mergeSegs(baseToks.map((t, i) => ({ text: t, hi: !matchedAll[i] })));
  return [baseSegs, afterSegs, refSegs];
}

/**
 * 2-way サイドバイサイド行。
 * row: { type, left, right }
 *   left/right: { num, segs, kind } | null(=empty)
 *   kind: 'plain'|'add'|'del'
 */
function build2Way(aLines, bLines) {
  const ops = diffLines(aLines, bLines);
  const rows = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'equal') {
      const o = ops[k];
      rows.push({
        type: 'equal',
        left: { num: o.aIndex + 1, segs: [{ text: o.text, hi: false }], kind: 'plain' },
        right: { num: o.bIndex + 1, segs: [{ text: o.text, hi: false }], kind: 'plain' },
      });
      k++;
      continue;
    }
    const dels = [];
    while (k < ops.length && ops[k].type === 'del') dels.push(ops[k++]);
    const adds = [];
    while (k < ops.length && ops[k].type === 'add') adds.push(ops[k++]);
    const max = Math.max(dels.length, adds.length);
    for (let p = 0; p < max; p++) {
      const d = dels[p], a = adds[p];
      if (d && a) {
        const w = wordDiff(d.text, a.text);
        rows.push({
          type: 'mod',
          left: { num: d.aIndex + 1, segs: w.oldSegs, kind: 'del' },
          right: { num: a.bIndex + 1, segs: w.newSegs, kind: 'add' },
        });
      } else if (d) {
        rows.push({
          type: 'del',
          left: { num: d.aIndex + 1, segs: [{ text: d.text, hi: false }], kind: 'del' },
          right: null,
        });
      } else {
        rows.push({
          type: 'add',
          left: null,
          right: { num: a.bIndex + 1, segs: [{ text: a.text, hi: false }], kind: 'add' },
        });
      }
    }
  }
  return rows;
}

function segsText(cell) {
  return cell && cell.segs ? cell.segs.map((s) => s.text).join('') : '';
}

/**
 * base に対する other の対応表（3-way 用）。
 * 2-way の正しいペアリング（build2Way）を土台にすることで、
 * 変更行の対応付けや挿入位置のズレを防ぐ。
 *   of[b]: { text, changed } | null(=other で削除) | undefined(=未対応)
 *   inserts: Map(anchorBaseIndex -> [otherText]) … other 側のみの行
 */
function mapToBase(base, other) {
  const rows = build2Way(base, other);
  const of = new Array(base.length).fill(undefined);
  const inserts = new Map();
  let lastBaseIdx = 0; // 直近までに消費した base 行数（挿入のアンカー）
  for (const r of rows) {
    if (r.left) {
      const b = r.left.num - 1;
      if (r.right) of[b] = { text: segsText(r.right), changed: r.type === 'mod' }; // equal or mod
      else of[b] = null; // del: other で削除
      lastBaseIdx = b + 1;
    } else if (r.right) {
      const arr = inserts.get(lastBaseIdx) || [];
      arr.push(segsText(r.right));
      inserts.set(lastBaseIdx, arr);
    }
  }
  return { of, inserts };
}

/**
 * base セル。after / reference のいずれかと異なる文字を行内ハイライトする。
 * kind: 'base'(差分なし) | 'diff'(差分あり)
 */
function baseCell(baseText, aOf, rOf) {
  const removed = (aOf === null) || (rOf === null);
  const afterChanged = aOf && aOf.changed;
  const refChanged = rOf && rOf.changed;

  if (!afterChanged && !refChanged && !removed) {
    return { kind: 'base', segs: [{ text: baseText, hi: false }] };
  }
  // 相手が「削除」→ 行全体が差分（セル背景＋左バーで表現）
  if (removed && !afterChanged && !refChanged) {
    return { kind: 'diff', segs: [{ text: baseText, hi: false }] };
  }
  // 「変更」相手（after 優先、ref も）に対し、異なるトークンを union でハイライト
  const toks = tokenize(baseText);
  const matchedAll = new Array(toks.length).fill(true);
  const targets = [];
  if (afterChanged) targets.push(aOf.text);
  if (refChanged) targets.push(rOf.text);
  for (const tgt of targets) {
    const m = lcsMatchFlags(toks, tokenize(tgt));
    for (let i = 0; i < toks.length; i++) matchedAll[i] = matchedAll[i] && m[i];
  }
  const segs = mergeSegs(toks.map((t, i) => ({ text: t, hi: !matchedAll[i] })));
  return { kind: 'diff', segs };
}

/**
 * 3-way（3ペイン, 基準=左端 base）。
 * row: { c1, c2, c3 } 各 { kind:'base'|'diff'|'plain'|'add'|'empty', segs? , text? }
 */
function build3Way(base, after, ref) {
  const A = mapToBase(base, after);
  const R = mapToBase(base, ref);
  const rows = [];
  const otherCell = (m, b) => {
    const v = m.of[b];
    if (v === null || v === undefined) return { kind: 'empty' };
    if (!v.changed) return { kind: 'plain', segs: [{ text: v.text, hi: false }] };
    const w = wordDiff(base[b], v.text);
    return { kind: 'add', segs: w.newSegs };
  };
  const emitInserts = (k) => {
    for (const t of (A.inserts.get(k) || [])) {
      rows.push({ c1: { kind: 'empty' }, c2: { kind: 'add', segs: [{ text: t, hi: false }] }, c3: { kind: 'empty' } });
    }
    for (const t of (R.inserts.get(k) || [])) {
      rows.push({ c1: { kind: 'empty' }, c2: { kind: 'empty' }, c3: { kind: 'add', segs: [{ text: t, hi: false }] } });
    }
  };
  for (let b = 0; b < base.length; b++) {
    emitInserts(b);
    const aCell = otherCell(A, b);
    const rCell = otherCell(R, b);
    rows.push({
      c1: baseCell(base[b], A.of[b], R.of[b]),
      c2: aCell,
      c3: rCell,
    });
  }
  emitInserts(base.length);
  return rows;
}

/** テキストを行配列へ（末尾の余分な空行を1つ除去） */
function splitLines(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

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

/* ------------------------------------------------------------------
 * ここから下は BigQuery UDF 用のドライバ（build_udf.mjs が付加）
 * ------------------------------------------------------------------ */

function __notice(text) {
  return '<div style="padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #D0D7DE;' +
    'border-radius:4px;background:#F6F8FA;color:#57606A;' +
    "font:13px/1.6 'Roboto','Segoe UI',system-ui,sans-serif\">" +
    String(text).replace(/[<>&]/g, '') + '</div>';
}

/**
 * 変更行の前後 contextLines 行だけ残す（GitHub の折りたたみ相当）。
 * 行番号は各行が自分で持っているので、間引いても番号はズレない。
 * 省略箇所の「…」は出さない（番号が飛ぶこと自体が目印になる）。
 */
function __trimContext(rows, ctx) {
  var keep = new Array(rows.length);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'equal') {
      var lo = Math.max(0, i - ctx);
      var hi = Math.min(rows.length - 1, i + ctx);
      for (var j = lo; j <= hi; j++) keep[j] = true;
    }
  }
  var out = [];
  for (var k = 0; k < rows.length; k++) if (keep[k]) out.push(rows[k]);
  return out;
}

function __run(before_ddl, after_ddl, left_label, right_label, options_json) {
  var opts = {};
  if (options_json) {
    try { opts = JSON.parse(options_json) || {}; } catch (e) { opts = {}; }
  }

  var a = (before_ddl === null || before_ddl === undefined || before_ddl === '')
    ? [] : splitLines(before_ddl);
  var b = (after_ddl === null || after_ddl === undefined || after_ddl === '')
    ? [] : splitLines(after_ddl);

  if (a.length === 0 && b.length === 0) {
    return __notice('DDL が空です。key の指定を確認してください。');
  }
  // LCS は O(n*m)。UDF のメモリと実行時間の保険。
  if ((a.length + 1) * (b.length + 1) > 4000000) {
    return __notice('行数が多すぎるため差分計算を中止しました（' + a.length + ' 行 x ' + b.length + ' 行）。');
  }

  var rows = build2Way(a, b);

  var ctx = opts.contextLines;
  if (typeof ctx === 'number' && ctx >= 0 && isFinite(ctx)) {
    var trimmed = __trimContext(rows, ctx);
    // 全行同一なら間引いた結果が空になるので、その場合は案内を返す
    if (trimmed.length === 0) return __notice('差分はありません。');
    rows = trimmed;
  }

  return renderFragment2(
    left_label || 'before',
    right_label || 'after',
    rows,
    opts
  );
}

return __run(before_ddl, after_ddl, left_label, right_label, options_json);
""";
