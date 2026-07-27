'use strict';

/**
 * Myers の差分アルゴリズム（線形空間版 / diff-match-patch の bisect 相当）。
 * 依存パッケージ無しで動くように自前実装している。
 *
 * 入力は「比較可能な値の配列」（行 ID の配列 / トークンの配列）。
 * 出力は [op, aIndex, bIndex] の配列。
 *   op =  0 : 一致       (aIndex, bIndex ともに有効)
 *   op = -1 : a のみ     (bIndex = -1)
 *   op =  1 : b のみ     (aIndex = -1)
 */

const EQUAL = 0;
const DELETE = -1;
const INSERT = 1;

/**
 * @param {ArrayLike<any>} a
 * @param {ArrayLike<any>} b
 * @returns {Array<[number, number, number]>}
 */
function diff(a, b) {
  const out = [];
  diffRange(a, b, 0, a.length, 0, b.length, out);
  return out;
}

function diffRange(a, b, aLo, aHi, bLo, bHi, out) {
  // 共通の先頭を切り落とす
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    out.push([EQUAL, aLo++, bLo++]);
  }
  // 共通の末尾を切り落とす（順序を保つため後で push する）
  const suffix = [];
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
    suffix.push([EQUAL, aHi, bHi]);
  }

  const n = aHi - aLo;
  const m = bHi - bLo;

  if (n === 0) {
    for (let j = bLo; j < bHi; j++) out.push([INSERT, -1, j]);
  } else if (m === 0) {
    for (let i = aLo; i < aHi; i++) out.push([DELETE, i, -1]);
  } else {
    const split = bisect(a, b, aLo, aHi, bLo, bHi);
    if (split) {
      diffRange(a, b, aLo, split.x, bLo, split.y, out);
      diffRange(a, b, split.x, aHi, split.y, bHi, out);
    } else {
      // 保険: 分割できなかった場合は全置換として扱う
      for (let i = aLo; i < aHi; i++) out.push([DELETE, i, -1]);
      for (let j = bLo; j < bHi; j++) out.push([INSERT, -1, j]);
    }
  }

  for (let k = suffix.length - 1; k >= 0; k--) out.push(suffix[k]);
}

/**
 * 前方・後方の探索を突き合わせて、編集パスの中間点で範囲を 2 分割する。
 * 戻り値は絶対インデックス。分割位置が範囲の端に張り付いた場合は null を返す
 * （無限再帰の防止）。
 */
function bisect(a, b, aLo, aHi, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[offset + 1] = 0;
  v2[offset + 1] = 0;
  const delta = n - m;
  // delta が奇数なら前方探索側で、偶数なら後方探索側で重なりを判定する
  const front = (delta & 1) !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;

  for (let d = 0; d < maxD; d++) {
    // 前方探索
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = offset + k1;
      let x1;
      if (k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1])) {
        x1 = v1[k1Offset + 1];
      } else {
        x1 = v1[k1Offset - 1] + 1;
      }
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1Offset] = x1;
      if (x1 > n) {
        k1end += 2;
      } else if (y1 > m) {
        k1start += 2;
      } else if (front) {
        const k2Offset = offset + delta - k1;
        if (k2Offset >= 0 && k2Offset < size && v2[k2Offset] !== -1) {
          const x2 = n - v2[k2Offset];
          if (x1 >= x2) return makeSplit(aLo, bLo, x1, y1, n, m);
        }
      }
    }

    // 後方探索（v2 は末尾からの距離を保持する）
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = offset + k2;
      let x2;
      if (k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1])) {
        x2 = v2[k2Offset + 1];
      } else {
        x2 = v2[k2Offset - 1] + 1;
      }
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2Offset] = x2;
      if (x2 > n) {
        k2end += 2;
      } else if (y2 > m) {
        k2start += 2;
      } else if (!front) {
        const k1Offset = offset + delta - k2;
        if (k1Offset >= 0 && k1Offset < size && v1[k1Offset] !== -1) {
          const x1 = v1[k1Offset];
          const y1 = offset + x1 - k1Offset;
          if (x1 >= n - x2) return makeSplit(aLo, bLo, x1, y1, n, m);
        }
      }
    }
  }
  return null;
}

function makeSplit(aLo, bLo, x, y, n, m) {
  // 端に張り付いた分割は再帰が進まないので拒否する
  if ((x === 0 && y === 0) || (x === n && y === m)) return null;
  return { x: aLo + x, y: bLo + y };
}

/**
 * 行文字列の配列を、比較用の整数 ID 配列に変換する。
 * 文字列比較より整数比較のほうが速く、`normalize` で空白無視も表現できる。
 *
 * @param {string[]} lines
 * @param {Map<string, number>} dict 複数ファイルで共有する辞書
 * @param {(s: string) => string} normalize
 * @returns {Int32Array}
 */
function toIds(lines, dict, normalize) {
  const ids = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const key = normalize(lines[i]);
    let id = dict.get(key);
    if (id === undefined) {
      id = dict.size;
      dict.set(key, id);
    }
    ids[i] = id;
  }
  return ids;
}

/**
 * 単語単位の差分用トークナイザ。
 * 「英数字の連なり」「連続空白」「それ以外は 1 文字」に分割する。
 * 日本語は 1 文字ずつ扱ったほうが差分が細かく出るので、まとめない。
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text.match(/[A-Za-z0-9_$]+|\s+|[^\s]/g) || [];
}

module.exports = { diff, toIds, tokenize, EQUAL, DELETE, INSERT };
