'use strict';
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

module.exports = { diffLines, wordDiff, build2Way, build3Way, mapToBase, splitLines, tokenize, nameDiff };
