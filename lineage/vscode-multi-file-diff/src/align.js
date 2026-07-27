'use strict';

const { diff, toIds, tokenize, EQUAL, DELETE, INSERT } = require('./diff');

/**
 * 2〜3 ファイルの行を突き合わせて、Webview がそのまま描画できる行データを組み立てる。
 *
 * 出力する行（row）の形:
 *   {
 *     c: 0 | 1,                       // 1 なら差分行
 *     cells: [
 *       {
 *         n: number | null,           // 行番号（1 始まり）/ 対応行なしなら null
 *         t: string | null,           // 行テキスト / 対応行なしなら null
 *         k: 'same' | 'base' | 'diff' | 'none',
 *         s?: Array<[0|1, string]>    // 単語単位ハイライト（差分部分が 1）
 *       }, ...
 *     ]
 *   }
 *
 * 色の付け方は VS Code の 2 画面 diff に合わせる。
 *   - 1 番目に選択したファイルを「基準（base = 赤系）」とする。
 *   - 基準と内容が違うセルを「差分（diff = 緑系）」とする。
 *   - 基準と同じ内容のセルは基準と同じ色になる（＝どのファイル同士が一致しているか分かる）。
 *   - 対応する行が無いセルは none（斜線塗り）。
 */

/**
 * @param {string[][]} files 各ファイルの行配列（2 or 3 要素）
 * @param {{ignoreTrimWhitespace?: boolean, ignoreCase?: boolean, wordDiff?: boolean}} [options]
 */
function buildRows(files, options = {}) {
  const normalize = makeNormalizer(options);
  const dict = new Map();
  const ids = files.map((lines) => toIds(lines, dict, normalize));

  const skeleton = packBlocks(
    files.length === 2 ? alignTwo(ids[0], ids[1]) : alignThree(ids[0], ids[1], ids[2]),
    files.length
  );

  const rows = [];
  let changedCount = 0;
  for (const slot of skeleton) {
    const row = makeRow(files, ids, slot, options);
    if (row.c) changedCount++;
    rows.push(row);
  }
  return { rows, changedCount };
}

function makeNormalizer(options) {
  const trim = options.ignoreTrimWhitespace !== false;
  const lower = options.ignoreCase === true;
  if (trim && lower) return (s) => s.trim().toLowerCase();
  if (trim) return (s) => s.trim();
  if (lower) return (s) => s.toLowerCase();
  return (s) => s;
}

/** 2 ファイルの行対応（[aIndex, bIndex] の並び。無い側は -1） */
function alignTwo(a, b) {
  const slots = [];
  for (const [op, ai, bi] of diff(a, b)) {
    if (op === EQUAL) slots.push([ai, bi]);
    else if (op === DELETE) slots.push([ai, -1]);
    else slots.push([-1, bi]);
  }
  return slots;
}

/**
 * 3 ファイルの行対応。真ん中のファイル B を軸に A↔B と B↔C を突き合わせる。
 * B に無い行（A だけ / C だけ）は、同じ挿入位置ごとに A 側と C 側をさらに
 * 突き合わせてから並べるので、「B から消えただけで A と C には有る行」が
 * 同じ行に揃う。
 */
function alignThree(a, b, c) {
  const fromA = mapAgainstBase(a, b);
  const fromC = mapAgainstBase(c, b);
  const slots = [];

  for (let bi = 0; bi <= b.length; bi++) {
    const aOnly = fromA.only[bi];
    const cOnly = fromC.only[bi];
    if (aOnly || cOnly) {
      for (const [ai, ci] of zipOnly(a, c, aOnly || [], cOnly || [])) {
        slots.push([ai, -1, ci]);
      }
    }
    if (bi < b.length) slots.push([fromA.paired[bi], bi, fromC.paired[bi]]);
  }
  return slots;
}

/**
 * 側 x と基準 base を突き合わせ、
 *   paired[baseIndex] = 対応する x の行番号（無ければ -1）
 *   only[baseIndex]   = その基準行の直前に挿入される x 専用行の配列
 * を返す。only[base.length] は末尾に付く分。
 */
function mapAgainstBase(x, base) {
  const paired = new Int32Array(base.length).fill(-1);
  const only = new Array(base.length + 1);
  let cursor = 0;
  for (const [op, xi, bi] of diff(x, base)) {
    if (op === EQUAL) {
      paired[bi] = xi;
      cursor = bi + 1;
    } else if (op === INSERT) {
      // 基準にだけ有る行
      cursor = bi + 1;
    } else {
      (only[cursor] || (only[cursor] = [])).push(xi);
    }
  }
  return { paired, only };
}

/** A 専用行と C 専用行を内容で突き合わせて [aIndex, cIndex] の並びにする */
function zipOnly(a, c, aOnly, cOnly) {
  if (aOnly.length === 0) return cOnly.map((ci) => [-1, ci]);
  if (cOnly.length === 0) return aOnly.map((ai) => [ai, -1]);

  const aIds = aOnly.map((i) => a[i]);
  const cIds = cOnly.map((i) => c[i]);
  const pairs = [];
  for (const [op, i, j] of diff(aIds, cIds)) {
    if (op === EQUAL) pairs.push([aOnly[i], cOnly[j]]);
    else if (op === DELETE) pairs.push([aOnly[i], -1]);
    else pairs.push([-1, cOnly[j]]);
  }
  return pairs;
}

/**
 * 行単位の差分は「1 行の変更」を『削除 1 行 + 追加 1 行』として返す。
 * そのままだと変更が上下 2 行に分かれてしまうので、欠けのある行が連続する
 * かたまりを列ごとに上に詰め直し、VS Code の差分エディタと同じように
 * 変更前後が左右に並ぶようにする。
 *
 * @param {number[][]} slots
 * @param {number} cols
 */
function packBlocks(slots, cols) {
  const out = [];
  let i = 0;
  while (i < slots.length) {
    if (isComplete(slots[i], cols)) {
      out.push(slots[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < slots.length && !isComplete(slots[j], cols)) j++;

    const columns = [];
    let height = 0;
    for (let f = 0; f < cols; f++) {
      const indices = [];
      for (let k = i; k < j; k++) {
        if (slots[k][f] >= 0) indices.push(slots[k][f]);
      }
      columns.push(indices);
      if (indices.length > height) height = indices.length;
    }
    for (let r = 0; r < height; r++) {
      const slot = new Array(cols);
      for (let f = 0; f < cols; f++) {
        slot[f] = r < columns[f].length ? columns[f][r] : -1;
      }
      out.push(slot);
    }
    i = j;
  }
  return out;
}

function isComplete(slot, cols) {
  for (let f = 0; f < cols; f++) {
    if (slot[f] < 0) return false;
  }
  return true;
}

function makeRow(files, ids, slot, options) {
  const cells = [];
  let missing = false;

  // 基準は必ず 1 番目のファイル。1 番目に対応行が無い行（＝他ファイルで
  // 追加された行）は、どのセルも「追加」扱いにして緑系で表示する。
  const baseIndex = slot[0];
  const baseId = baseIndex >= 0 ? ids[0][baseIndex] : -1;
  const baseText = baseIndex >= 0 ? files[0][baseIndex] : null;

  for (let f = 0; f < files.length; f++) {
    const index = slot[f];
    if (index < 0) {
      cells.push({ n: null, t: null, k: 'none' });
      missing = true;
      continue;
    }
    cells.push({
      n: index + 1,
      t: files[f][index],
      k: 'same',
      _id: ids[f][index],
    });
  }

  let differs = false;
  for (const cell of cells) {
    if (cell.k === 'none') continue;
    if (cell._id !== baseId) differs = true;
  }

  const changed = missing || differs;
  if (changed) {
    for (const cell of cells) {
      if (cell.k === 'none') continue;
      cell.k = cell._id === baseId ? 'base' : 'diff';
    }
    if (options.wordDiff !== false && differs) applyWordDiff(cells, baseText);
  }

  for (const cell of cells) {
    delete cell._id;
  }
  return { c: changed ? 1 : 0, cells };
}

/**
 * 基準セルと、それと異なるセルの間で単語単位の差分を取り、
 * 変わっている箇所だけ強調表示用のセグメントに切り分ける。
 * 基準セル側は「異なる全てのセルとの差分の和集合」を強調する。
 */
function applyWordDiff(cells, baseText) {
  const targets = cells.filter((cell) => cell.k === 'diff' && cell.t !== null);
  if (targets.length === 0 || baseText === null) return;

  const baseTokens = tokenize(baseText);
  if (baseTokens.length > 4000) return; // 極端に長い行では単語差分を諦める
  const baseChanged = new Uint8Array(baseTokens.length);

  for (const cell of targets) {
    const tokens = tokenize(cell.t);
    if (tokens.length > 4000) continue;
    const changed = new Uint8Array(tokens.length);
    for (const [op, bi, ti] of diff(baseTokens, tokens)) {
      if (op === DELETE) baseChanged[bi] = 1;
      else if (op === INSERT) changed[ti] = 1;
    }
    const segs = toSegments(tokens, changed);
    if (segs) cell.s = segs;
  }

  const baseSegs = toSegments(baseTokens, baseChanged);
  if (baseSegs) {
    for (const cell of cells) {
      if (cell.k === 'base' && cell.t === baseText) cell.s = baseSegs;
    }
  }
}

/** 連続する同種トークンをまとめて [flag, text] の配列にする。全て同種なら null */
function toSegments(tokens, flags) {
  let hasChange = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      hasChange = true;
      break;
    }
  }
  if (!hasChange) return null;

  const segs = [];
  let current = flags[0] ? 1 : 0;
  let buffer = '';
  for (let i = 0; i < tokens.length; i++) {
    const flag = flags[i] ? 1 : 0;
    if (flag !== current) {
      segs.push([current, buffer]);
      current = flag;
      buffer = '';
    }
    buffer += tokens[i];
  }
  segs.push([current, buffer]);
  // 行全体が差分なら、セグメント分割せず行背景だけで表現する
  if (segs.length === 1 && segs[0][0] === 1) return null;
  return segs;
}

module.exports = { buildRows };
