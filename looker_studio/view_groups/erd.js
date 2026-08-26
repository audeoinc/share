'use strict';
/**
 * パラメータ化 SQL から「何が何を作っているか」の図を起こす。
 *
 *   実テーブル ──▶ CTE ──▶ CTE ──▶ (最終 SELECT)
 *
 * 節は実体（実テーブル / CTE / サブクエリ / UNNEST）、辺は「読んで作る」関係。
 * JOIN の種別と結合キーは、読む側へ入る辺の注記として出す。
 * 辺を別に引くより、消費する側にぶら下げたほうが図が素直に読める。
 *
 * これは厳密には ER 図ではなく**参照関係図**。SQL からはカーディナリティも
 * 主キーも分からないので、そこは描かない。それらしく描くと、確かめていない
 * ことを確かめたように見せてしまう。
 *
 * 解析は analyze.js のトークナイザに乗る。markEntities が FROM / JOIN の
 * 位置を判定済みなので、その印を使う（パーサーは持たない）。
 *
 * 入れ子のスコープ（EXISTS の相関サブクエリ、FROM (SELECT …)、スカラー
 * サブクエリ）で参照している実体は、**囲んでいる CTE の入力**として扱う。
 * 入れ子を図でも入れ子にすると読めなくなるうえ、「この CTE は何を読むか」
 * という問いには平らにした形のほうが答えている。
 */

const { tokenizeSql, markEntities } = require('./analyze.js');
const { esc, label, header, notice, referenceIndex } = require('./chrome.js');

const BOX_W = 188;
const BOX_H = 42;
const GAP_X = 108;  // 段の間隔。辺の注記をこの溝に収めるので、狭いと箱に重なる
const GAP_Y = 16;
const PAD = 10;

const kw = (t) => (t && t.kind === 'keyword' ? t.text.toUpperCase() : null);

/** 空白とコメントを落とし、括弧の深さを付ける。 */
function prepare(sql) {
  const out = [];
  let depth = 0;
  for (const t of markEntities(tokenizeSql(sql))) {
    if (t.kind === 'space' || t.kind === 'comment') continue;
    if (t.text === ')') depth--;
    out.push({ kind: t.kind, text: t.text, depth });
    if (t.text === '(') depth++;
  }
  return out;
}

/**
 * 先頭の WITH から CTE の範囲を取る。
 * @returns {{ctes: Array<{name, from, to, depth}>, mainFrom: number}}
 */
function cteRanges(ts) {
  const ctes = [];
  if (!(ts[0] && kw(ts[0]) === 'WITH')) return { ctes, mainFrom: 0 };
  let i = 1;
  for (;;) {
    const name = ts[i], as = ts[i + 1], open = ts[i + 2];
    if (!open || name.kind !== 'ident' || kw(as) !== 'AS' || open.text !== '(') break;
    const d = open.depth;
    let j = i + 3;
    while (j < ts.length && !(ts[j].text === ')' && ts[j].depth === d)) j++;
    ctes.push({ name: name.text, from: i + 3, to: j, depth: d + 1 });
    i = j + 1;
    if (ts[i] && ts[i].text === ',') { i++; continue; }
    break;
  }
  return { ctes, mainFrom: i };
}

// スコープの区切りになる予約語。ON 条件の読み終わりを決めるのに使う。
const STOP = new Set(['WHERE', 'GROUP', 'ORDER', 'QUALIFY', 'WINDOW', 'HAVING',
  'UNION', 'INTERSECT', 'EXCEPT', 'LIMIT', 'SELECT', 'JOIN', 'FROM']);

/** 括弧の対応を取って閉じ位置の次を返す。 */
function skipParen(ts, i, to) {
  const d = ts[i].depth;
  let j = i + 1;
  while (j < to && !(ts[j].text === ')' && ts[j].depth === d)) j++;
  return j + 1;
}

/**
 * FROM / JOIN の直後にあるソースを 1 つ読む。
 * @returns {{node: object, next: number}}
 */
function readSource(ts, j, to) {
  if (j >= to) return { node: null, next: j };
  const t = ts[j];
  if (t.text === '(') {
    return { node: { name: '(サブクエリ)', kind: 'subquery' }, next: skipParen(ts, j, to) };
  }
  if (kw(t) === 'UNNEST') {
    let k = j + 1;
    let arg = '';
    if (ts[k] && ts[k].text === '(') {
      const d = ts[k].depth;
      let m = k + 1;
      while (m < to && !(ts[m].text === ')' && ts[m].depth === d)) { arg += ts[m].text; m++; }
      k = m + 1;
    }
    return { node: { name: 'UNNEST(' + arg + ')', kind: 'unnest' }, next: k };
  }
  if (t.kind === 'entity' || t.kind === 'quoted' || t.kind === 'ident') {
    const parts = [];
    let k = j;
    while (k < to && (ts[k].kind === 'entity' || ts[k].kind === 'quoted' || ts[k].kind === 'ident')) {
      parts.push(ts[k].text);
      k++;
      if (k < to && ts[k].text === '.') { k++; continue; }
      break;
    }
    // 関数呼び出し（テーブル関数）は実体ではない
    if (k < to && ts[k].text === '(') return { node: null, next: skipParen(ts, k, to) };
    return { node: { name: parts.join('.'), kind: 'ref' }, next: k };
  }
  return { node: null, next: j + 1 };
}

/** 別名（AS x / x）を読み飛ばす。 */
function skipAlias(ts, j, to) {
  if (j < to && kw(ts[j]) === 'AS') {
    const nm = ts[j + 1];
    if (nm && (nm.kind === 'ident' || nm.kind === 'quoted')) return j + 2;
    return j + 1;
  }
  if (j < to && ts[j].kind === 'ident' && !STOP.has(ts[j].text.toUpperCase())) return j + 1;
  return j;
}

/** ON 条件から `a.col = b.col` を拾う。列名が一致していれば 1 つにまとめる。 */
function readOnKeys(ts, j, to) {
  const keys = [];
  let k = j;
  while (k < to) {
    const up = kw(ts[k]);
    if (up && STOP.has(up)) break;
    if (up === 'LEFT' || up === 'RIGHT' || up === 'FULL' || up === 'INNER' || up === 'CROSS') break;
    if (ts[k].text === '=') {
      const col = (a, b, c) => (a && b && c && b.text === '.' ? c.text : null);
      const l = col(ts[k - 3], ts[k - 2], ts[k - 1]);
      const r = col(ts[k + 1], ts[k + 2], ts[k + 3]);
      if (l && r) keys.push(l === r ? l : l + ' = ' + r);
    }
    k++;
  }
  return { keys, next: k };
}

/** USING (a, b) の列を拾う。 */
function readUsingKeys(ts, j, to) {
  const keys = [];
  let k = j;
  if (ts[k] && ts[k].text === '(') {
    const d = ts[k].depth;
    k++;
    while (k < to && !(ts[k].text === ')' && ts[k].depth === d)) {
      if (ts[k].kind === 'ident') keys.push(ts[k].text);
      k++;
    }
    k++;
  }
  return { keys, next: k };
}

/** JOIN の種別（直前の LEFT / INNER … を見る）。 */
function joinKind(ts, i, from) {
  for (let k = i - 1; k >= from && i - k <= 3; k--) {
    const p = kw(ts[k]);
    if (p === 'LEFT' || p === 'RIGHT' || p === 'FULL' || p === 'CROSS') return p;
    if (p === 'INNER') return 'INNER';
  }
  return 'INNER';
}

/**
 * 1 スコープ分のソースを読む。
 * scopeDepth と同じ深さの FROM / JOIN が「主たる読み口」で、
 * それより深いものは入れ子（サブクエリ）として印を付ける。
 */
function scanScope(ts, from, to, scopeDepth) {
  const inputs = [];
  for (let i = from; i < to; i++) {
    const up = kw(ts[i]);
    if (up !== 'FROM' && up !== 'JOIN') continue;
    const nested = ts[i].depth > scopeDepth;
    const jt = up === 'JOIN' ? joinKind(ts, i, from) : null;
    let j = i + 1;
    for (;;) {
      const r = readSource(ts, j, to);
      j = r.next;
      if (r.node) {
        j = skipAlias(ts, j, to);
        let keys = [];
        if (!nested && j < to && kw(ts[j]) === 'ON') {
          const k = readOnKeys(ts, j + 1, to); keys = k.keys; j = k.next;
        } else if (!nested && j < to && kw(ts[j]) === 'USING') {
          const k = readUsingKeys(ts, j + 1, to); keys = k.keys; j = k.next;
        }
        if (r.node.kind !== 'unnest') {
          inputs.push({ name: r.node.name, kind: r.node.kind, joinType: jt, keys, nested });
        }
      }
      // 'FROM a, b' のカンマ続き
      if (j < to && ts[j].text === ',' && ts[j].depth === ts[i].depth) { j++; continue; }
      break;
    }
    i = Math.max(i, j - 1);
  }
  return inputs;
}

/**
 * パラメータ化 SQL から参照関係のグラフを組み立てる。
 * @param {string} sql   グループのパラメータ化 SQL
 * @param {object[]} params  parameterize() が返した一覧（{{Pn}} の実値）
 * @returns {{nodes: object[], edges: object[]}}
 */
function buildGraph(sql, params) {
  // {{P1}} のままだと '{' '{' 'P1' '}' '}' の 5 トークンに割れ、実体名として
  // 読めない（markEntities も印を付けられない）。先に代表 View の値へ戻してから
  // 解析する。どの名前がパラメータ由来かは値から引き直して注記に使う。
  const byName = new Map((params || []).map((p) => [p.name, p]));
  const firstValue = (p) => {
    const k = Object.keys(p.values);
    return k.length ? p.values[k[0]] : null;
  };
  const valueToParam = new Map();
  const resolved = String(sql).replace(/\{\{(P\d+)\}\}/g, (m, key) => {
    const p = byName.get(key);
    if (!p) return m;
    const v = firstValue(p);
    if (v == null) return m;
    valueToParam.set(v, p);
    return v;
  });

  const ts = prepare(resolved);
  const { ctes, mainFrom } = cteRanges(ts);
  const cteNames = new Set(ctes.map((c) => c.name));

  const nodes = new Map();
  const edges = [];
  const put = (name, kind) => {
    const id = kind + ':' + name;
    if (!nodes.has(id)) {
      // 名前のうち、値を戻した箇所がどのパラメータだったかを覚えておく。
      // バッククォートで囲われていれば名前まるごとで 1 つのパラメータ。
      // 裸のパスは区切りごとに置換されるので、当たらなければ部分で引き直す。
      // 先に全体で引くのが要点で、部分から先に見ると
      // `PRJ.mart_abjp.orders_abjp` の 'mart_abjp' が別のパラメータに当たる。
      const used = [];
      const whole = valueToParam.get(String(name));
      if (whole) used.push(whole);
      else {
        for (const part of String(name).split('.')) {
          const p = valueToParam.get(part);
          if (p && used.indexOf(p) < 0) used.push(p);
        }
      }
      nodes.set(id, { id, name, label: name, kind, params: used });
    }
    return id;
  };

  const scopes = ctes.map((c) => ({ id: put(c.name, 'cte'), from: c.from, to: c.to, depth: c.depth }));
  scopes.push({ id: put('(最終 SELECT)', 'output'), from: mainFrom, to: ts.length, depth: 0 });

  for (const sc of scopes) {
    for (const inp of scanScope(ts, sc.from, sc.to, sc.depth)) {
      const kind = inp.kind === 'ref'
        ? (cteNames.has(inp.name) ? 'cte' : 'table')
        : inp.kind;
      const fromId = put(inp.name, kind);
      if (fromId === sc.id) continue; // 自己参照は描かない
      const same = edges.find((e) => e.from === fromId && e.to === sc.id);
      if (same) {
        if (!same.keys.length) same.keys = inp.keys;
        if (!same.joinType) same.joinType = inp.joinType;
        same.nested = same.nested && inp.nested;
      } else {
        edges.push({ from: fromId, to: sc.id, joinType: inp.joinType, keys: inp.keys, nested: inp.nested });
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * 段組みに配置する。
 *
 * 段は「できるだけ遅く」置く（ALAP）。最長路で前詰めにすると、
 * 参照テーブルが左端に並んで消費する CTE まで線が何段もまたぎ、
 * 途中の箱の上を横切って読めなくなる。消費する側の直前に置けば、
 * どの辺も 1 段しかまたがない。
 *
 * 段の中の並びは、直前の段にある入力の平均位置に寄せる（重心法）。
 * 交差を厳密に最小化はしないが、1 回まわすだけで見違える。
 *
 * 循環は無い前提だが、壊れた SQL でも止まるよう回数で打ち切る。
 */
function layout(graph) {
  const { nodes, edges } = graph;
  const inc = new Map(nodes.map((n) => [n.id, []]));
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (inc.has(e.to)) inc.get(e.to).push(e.from);
    if (out.has(e.from)) out.get(e.from).push(e.to);
  }

  // まず最長路で深さを出し、全体の段数を決める
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let moved = false;
    for (const n of nodes) {
      const ins = inc.get(n.id);
      if (!ins.length) continue;
      const r = Math.max(...ins.map((f) => rank.get(f) || 0)) + 1;
      if (r > rank.get(n.id)) { rank.set(n.id, r); moved = true; }
    }
    if (!moved) break;
  }
  const last = Math.max(0, ...nodes.map((n) => rank.get(n.id)));

  // 出口を最終段に固定し、そこから「消費する側の 1 つ手前」へ寄せる
  const alap = new Map(nodes.map((n) => [n.id, out.get(n.id).length ? Infinity : last]));
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let moved = false;
    for (const n of nodes) {
      const outs = out.get(n.id);
      if (!outs.length) continue;
      const r = Math.min(...outs.map((t) => alap.get(t)));
      if (r - 1 < alap.get(n.id)) { alap.set(n.id, r - 1); moved = true; }
    }
    if (!moved) break;
  }
  for (const n of nodes) if (!Number.isFinite(alap.get(n.id))) alap.set(n.id, last);

  const cols = [];
  for (const n of nodes) {
    const r = Math.max(0, alap.get(n.id));
    (cols[r] || (cols[r] = [])).push(n);
  }

  // 重心法で段の中を並べ替える
  const row = new Map();
  cols.forEach((col, ci) => {
    if (!col) return;
    if (ci > 0) {
      col.sort((a, b2) => {
        const bc = (n) => {
          const ins = inc.get(n.id).filter((f) => row.has(f));
          if (!ins.length) return Number.MAX_SAFE_INTEGER;
          return ins.reduce((t, f) => t + row.get(f), 0) / ins.length;
        };
        return bc(a) - bc(b2);
      });
    }
    col.forEach((n, ri) => row.set(n.id, ri));
  });

  const placed = [];
  cols.forEach((col, ci) => {
    (col || []).forEach((n, ri) => {
      placed.push({ ...n,
        x: PAD + ci * (BOX_W + GAP_X),
        y: PAD + ri * (BOX_H + GAP_Y),
        w: BOX_W, h: BOX_H });
    });
  });
  const pos = new Map(placed.map((n) => [n.id, n]));
  const rows = Math.max(1, ...cols.map((c) => (c || []).length));
  return {
    nodes: placed,
    edges: edges.map((e) => ({ ...e, a: pos.get(e.from), b: pos.get(e.to) })).filter((e) => e.a && e.b),
    width: PAD * 2 + cols.length * BOX_W + Math.max(0, cols.length - 1) * GAP_X,
    height: PAD * 2 + rows * BOX_H + Math.max(0, rows - 1) * GAP_Y + 6,
  };
}

const KIND = {
  table: { text: '実テーブル', fill: '#FFFFFF', stroke: '#8C6D3F', bar: '#C9A227' },
  cte: { text: 'CTE', fill: '#FFFFFF', stroke: '#3F6D8C', bar: '#4E8FBF' },
  output: { text: '最終 SELECT', fill: '#FFFFFF', stroke: '#6D3F8C', bar: '#8250DF' },
  subquery: { text: 'サブクエリ', fill: '#FFFFFF', stroke: '#6E7781', bar: '#9AA4AE' },
};
const kindOf = (k) => KIND[k] || KIND.subquery;

/** 名前の最後の区切りだけを見出しにする（`p.d.t` → t）。 */
function shortName(s) {
  const bare = String(s).replace(/`/g, '');
  const i = bare.lastIndexOf('.');
  return i >= 0 ? bare.slice(i + 1) : bare;
}

// 箱に収まる文字数。SVG のテキストは箱からはみ出しても切られないので、
// ここで詰めておかないと隣の箱に重なる。全体は <title> で読める。
const MAX_CHARS = 23;
// 辺の注記が溝（GAP_X）に収まる文字数。10px の等幅で 1 文字およそ 5.9px。
const LABEL_CHARS = Math.floor(GAP_X / 5.9);
function fit(s) {
  const t = String(s);
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS - 1) + '…' : t;
}

/** 辺の注記。JOIN 種別と結合キー。 */
function edgeLabel(e) {
  const parts = [];
  if (e.joinType) parts.push(e.joinType === 'INNER' ? 'JOIN' : e.joinType + ' JOIN');
  if (e.keys && e.keys.length) parts.push(e.keys.join(', '));
  if (!parts.length && e.nested) parts.push('サブクエリ');
  return parts.join(' / ');
}

/**
 * SVG を組み立てる。
 * 色や線の太さは style 属性ではなく表示属性で書く。style を使うと
 * mode='class' がハッシュしてクラス名にするので、CSS を貼り直すまで
 * 素の見た目になってしまう。
 */
function toSvg(lay) {
  const out = [];
  out.push(`<svg viewBox="0 0 ${lay.width} ${lay.height}" width="${lay.width}" height="${lay.height}" ` +
    `role="img" aria-label="参照関係図" xmlns="http://www.w3.org/2000/svg">`);
  out.push('<defs><marker id="vgarrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" ' +
    'markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#8C96A0"/></marker></defs>');

  // 線 → 注記 → 箱 の順に描く。注記を線より先に描くと、あとから引いた
  // 別の辺が上に乗って読めなくなる。箱は最後なので必ず手前に来る。
  const labels = [];
  for (const e of lay.edges) {
    const x1 = e.a.x + e.a.w, y1 = e.a.y + e.a.h / 2;
    const x2 = e.b.x, y2 = e.b.y + e.b.h / 2;
    // 縦に折れる位置は相手の直前の溝。段をまたぐ辺でも箱の上を横切らない。
    const mid = x2 > x1 ? x2 - GAP_X / 2 : x1 + GAP_X / 2;
    const d = `M${x1},${y1} H${mid} V${y2} H${x2}`;
    const full = edgeLabel(e);
    out.push(`<path d="${d}" fill="none" stroke="#8C96A0" stroke-width="1.2" ` +
      `${e.nested ? 'stroke-dasharray="4 3" ' : ''}marker-end="url(#vgarrow)">` +
      (full ? `<title>${esc(full)}</title>` : '') + '</path>');
    if (full) labels.push({ x: mid, y: (y1 + y2) / 2 - 5, text: full });
  }
  for (const l of labels) {
    // 溝に収まる長さに詰める。全体は線の <title> で読める。
    const t = l.text.length > LABEL_CHARS ? l.text.slice(0, LABEL_CHARS - 1) + '…' : l.text;
    const w = t.length * 5.9 + 6;
    out.push(`<rect x="${(l.x - w / 2).toFixed(1)}" y="${l.y - 9}" width="${w.toFixed(1)}" ` +
      `height="12" rx="2" fill="#FFFFFF" opacity="0.92"/>`);
    out.push(`<text x="${l.x}" y="${l.y}" text-anchor="middle" ` +
      `font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="10" ` +
      `fill="#57606A">${esc(t)}</text>`);
  }

  for (const n of lay.nodes) {
    const k = kindOf(n.kind);
    const tip = n.label + (n.params.length
      ? '\n' + n.params.map((p) => p.name + ': ' +
        Object.keys(p.values).map((k) => k + ' = ' + p.values[k]).join(' / ')).join('\n')
      : '');
    out.push(`<g><title>${esc(tip)}</title>`);
    out.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5" ` +
      `fill="${k.fill}" stroke="${k.stroke}" stroke-width="1"/>`);
    out.push(`<rect x="${n.x}" y="${n.y}" width="4" height="${n.h}" rx="2" fill="${k.bar}"/>`);
    out.push(`<text x="${n.x + 12}" y="${n.y + 18}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" ` +
      `font-size="11" font-weight="600" fill="#24292F">${esc(fit(shortName(n.label)))}</text>`);
    out.push(`<text x="${n.x + 12}" y="${n.y + 32}" font-family="Roboto,system-ui,sans-serif" ` +
      `font-size="9" fill="#8C96A0">${esc(k.text)}${n.params.length ? ' ・パラメータ' : ''}</text>`);
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('');
}

/** グループ 1 つ分の図。 */
function groupSvg(group) {
  return toSvg(layout(buildGraph(group.sql, group.params)));
}

/**
 * 参照関係図（ERD）のカード。グループごとに 1 枚を縦に積む。
 *
 * 差分はタブだが、こちらは積む。差分は「基準と 1 つを見比べる」ものなので
 * 一度に 2 つ出れば足りるのに対し、参照関係は系統ごとの構造そのものなので、
 * 並べて一望できたほうが読みやすい。切り替えの操作も要らない。
 *
 * 並びは差分と同じで基準が先頭。同じ base を見ているのに差分と ERD で
 * 並びが違うと、対応を取り直す手間が要る。
 */
function erdStack(groups, refIndex) {
  // 基準を先頭に、残りは元の順のまま。差分タブと並びをそろえる。
  const order = [groups[refIndex], ...groups.filter((_, i) => i !== refIndex)];
  return order.map((g, i) =>
    `<div class="vg-erdblock">` +
    `<div class="vg-erdhead">` +
    (i === 0 ? `<span class="vg-tbadge">基準</span>` : '') +
    `<span class="vg-erdname">${esc(label(g))}</span>` +
    `<span class="vg-tabn">${g.members.length}</span>` +
    `</div>` +
    `<div class="vg-erdbox">${groupSvg(g)}</div>` +
    `</div>`).join('');
}

/** 図の読み方。凡例が無いと線種と色が何を指すか分からない。 */
function erdLegend() {
  const item = (cls, text) => `<span class="vg-lg"><span class="vg-lgm ${cls}"></span>${esc(text)}</span>`;
  return `<div class="vg-legend">` +
    item('vg-lgt', '実テーブル') +
    item('vg-lgc', 'CTE') +
    item('vg-lgo', '最終 SELECT') +
    `<span class="vg-lg"><span class="vg-lgd"></span>サブクエリ経由の参照</span>` +
    `</div>`;
}

function renderErd(b, refIndex) {
  if (!b.groups.length) return notice('View が見つかりません。');
  return notice(
    'FROM / JOIN から起こした参照関係です。矢印は「読んで作る」向き、' +
    '注記は JOIN の種別と結合キー。カーディナリティと主キーは SQL からは' +
    '分からないので描いていません。' +
    'パラメータ化した名前は、基準の View の値で表示しています。'
  ) + erdLegend() + erdStack(b.groups, refIndex);
}

/** base 1 件分の ERD カード。 */
function renderErdBase(b, opts) {
  return `<div class="vg-root">` +
    header(b.base, b.viewCount, b.groups.length, b.unmatched) +
    renderErd(b, referenceIndex(b, opts)) +
    `</div>`;
}

module.exports = {
  prepare, cteRanges, scanScope, buildGraph, layout, toSvg, groupSvg,
  renderErdBase, erdStack, erdLegend,
  shortName, edgeLabel, BOX_W, BOX_H,
};
