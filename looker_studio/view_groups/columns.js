'use strict';
/**
 * View のカラム定義（INFORMATION_SCHEMA.COLUMNS）を 1 枚の表にする。
 *
 *   1 行 = 1 列名、1 列 = 1 ロジック グループ。セルは型・NULL 制約・並び順。
 *
 * グループごとのタブにしなかったのは、列名も型も短くて横に並べても収まるから。
 * 全グループを一度に見せれば、どこが揃っていないかをタブを押さずに見つけられる。
 * SQL は横に長いので差分側は 2 ペインだが、こちらは事情が違う。
 *
 * **カラム定義はグループではなく View ごとの属性。** 同じロジック グループなら
 * SQL は α 等価だが、参照先テーブルの型が違えば出力列の型も違う（amount が jp は
 * NUMERIC、us は FLOAT64 など）。これはロジック差分には出てこない。SQL は同一
 * だから。むしろこの表の一番の値打ちがそこなので、グループの代表 1 本を黙って
 * 出すのではなく、グループの中で食い違ったら必ず印を付ける。
 *
 * 出すのは型・NULL 制約・並び順・説明。**ただし「差」と見なすのは型と NULL 制約
 * だけで、並び順の違いには色を付けない。** グループが列を 1 本足すと以降の番号が
 * まとめてずれるので、色を付けると本当に見たい型の差がその中に埋もれる。
 * 番号は出すので、必要なら目で追える。
 *
 * **この表に「基準」は無い。** 全グループを横に並べている以上、どれか 1 つを
 * 基準に立てなくても違いはそのまま読める。差分側は「基準と 1 つを見比べる」
 * 作りなので基準が要るが、こちらは要らない。揃っていないセルは、その列で
 * いちばん多い値と違うものに色を付ける。
 */

const { esc, label, notice } = require('./chrome.js');

/** グループの中で揃っていないことを示す印。セルの中に置く。 */
const WARN = '⚠';

/**
 * グループ 1 つ分の「列名 → その列について分かっていること」。
 *
 * 同じグループでも View ごとに列が違いうるので、View ぶん貯めておく。
 * 並び順は最初に見た View の ordinal に合わせる（表の行の並びに使う）。
 */
function groupColumns(g, byView) {
  const out = new Map();
  const members = g.members || [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const suffix = (g.suffixes && g.suffixes[i]) || m.viewName;
    const cols = byView[m.viewName] || [];
    for (let k = 0; k < cols.length; k++) {
      const c = cols[k];
      let e = out.get(c.n);
      if (!e) {
        e = { name: c.n, desc: '', order: k, vals: [] };
        out.set(c.n, e);
      }
      // 説明は列ごとに 1 つ。最初に見つかったものを採る（View ごとに違うことは
      // 基本的に無く、あっても表を横に広げてまで並べる情報ではない）。
      if (!e.desc && c.d) e.desc = c.d;
      e.vals.push({
        suffix: suffix,
        type: c.t,
        // ordinal_position は 1 始まり。取れなければ並び順から補う
        ord: c.o == null ? k + 1 : c.o,
        // INFORMATION_SCHEMA は 'YES' / 'NO'。無ければ不明として扱う
        nullable: c.u == null || c.u === '' ? null : String(c.u).toUpperCase() !== 'NO',
      });
    }
  }
  return out;
}

/**
 * 表の行の並び。先頭グループの順を土台にして、そこに無い列を後ろに足す。
 * どのグループを土台にしても表の中身は変わらないので、単に先頭を使う。
 */
function columnOrder(maps) {
  const seen = new Set();
  const out = [];
  for (const m of maps) {
    const rows = [...m.values()].sort((a, b) => a.order - b.order);
    for (const e of rows) {
      if (!seen.has(e.name)) { seen.add(e.name); out.push(e.name); }
    }
  }
  return out;
}

/** いちばん多い値。同数なら先に出たほう。 */
function majority(sigs) {
  const count = new Map();
  for (const s of sigs) count.set(s, (count.get(s) || 0) + 1);
  let best = null;
  let bestN = -1;
  for (const s of sigs) {
    const n = count.get(s);
    if (n > bestN) { best = s; bestN = n; }
  }
  return best;
}

const nullText = (n) => (n === null ? 'NULL 不明' : n ? 'NULL 可' : 'NOT NULL');

/** 重複を除いて出現順に並べる。 */
function uniq(list) {
  const out = [];
  for (const v of list) if (out.indexOf(v) < 0) out.push(v);
  return out;
}

/**
 * そのグループでのセルの中身。
 *
 *   text  型。グループ内で割れていれば ' / ' で並べる
 *   meta  並び順と NULL 制約。型より弱い情報なので小さく添える
 *   sig   グループ同士を比べるための鍵。**並び順は入れない**（1 本足すと
 *         以降が全部ずれて、型の差が埋もれるため）
 *   mixed グループの中で揃っていない（型・NULL 制約・並び順のいずれか、
 *         またはこの列を持たない View がいる）
 */
function cellInfo(entry, memberCount) {
  if (!entry) return { text: null, meta: '', sig: null, mixed: false };
  const types = uniq(entry.vals.map((v) => v.type));
  const ords = uniq(entry.vals.map((v) => v.ord));
  const nulls = uniq(entry.vals.map((v) => nullText(v.nullable)));
  const mixed =
    uniq(entry.vals.map((v) => `${v.ord}|${v.type}|${v.nullable}`)).length > 1 ||
    entry.vals.length !== memberCount;
  return {
    text: types.join(' / '),
    meta: `#${ords.join(' / ')} · ${nulls.join(' / ')}`,
    sig: types.join(' / ') + '|' + nulls.join(' / '),
    mixed: mixed,
  };
}

/** グループ内で食い違ったときの内訳。tooltip に出す。 */
function mixedTip(entry, g) {
  const lines = entry.vals.map(
    (v) => `${v.suffix} = #${v.ord} ${v.type} ${nullText(v.nullable)}`);
  const have = entry.vals.map((v) => v.suffix);
  for (let i = 0; i < (g.members || []).length; i++) {
    const suffix = (g.suffixes && g.suffixes[i]) || g.members[i].viewName;
    if (have.indexOf(suffix) < 0) lines.push(`${suffix} = (この列を持たない)`);
  }
  return lines.join('\n');
}

/**
 * base 1 件分のカラム定義の表。
 * @param {object} b               解析結果の base 1 件分
 * @param {object} byView          { View 名: [{ n: 列名, t: 型, o: 並び順,
 *                                 u: is_nullable, d: 説明 }] }
 * @param {object} opts            referenceIndex を見る
 */
function renderColumns(b, byView) {
  const groups = b.groups || [];
  if (!groups.length) return notice('View が見つかりません。');
  const maps = groups.map((g) => groupColumns(g, byView || {}));
  const order = columnOrder(maps);
  if (!order.length) {
    return notice('カラム定義を取得できませんでした。' +
      'INFORMATION_SCHEMA.COLUMNS から列が読めているか確認してください。');
  }

  let diffRows = 0;
  let mixedCount = 0;
  const rows = order.map((name) => {
    const infos = groups.map((g, i) => cellInfo(maps[i].get(name), g.members.length));
    // グループ間で揃っているか。基準は立てず、いちばん多い値と違うものに色を付ける。
    const top = majority(infos.map((c) => c.sig));
    const uneven = infos.some((c) => c.sig !== top);
    if (uneven) diffRows++;
    const entry = groups.map((_, i) => maps[i].get(name)).filter((e) => e)[0];
    const cells = infos.map((c, i) => {
      const g = groups[i];
      const e = maps[i].get(name);
      const cls = ['vg-ccell'];
      if (!c.text) cls.push('vg-cnone');
      // 多数派と違う型・NULL 制約。並び順の違いは色にしない（上の説明のとおり）。
      else if (c.sig !== top) cls.push('vg-cdiff');
      if (c.mixed) { cls.push('vg-cmix'); mixedCount++; }
      const body = c.text
        ? esc(c.text) + (c.mixed
          ? `<span class="vg-cwarn" data-tip="${esc(mixedTip(e, g))}">${WARN}</span>` : '') +
          `<div class="vg-cmeta">${esc(c.meta)}</div>`
        : '—';
      return `<td class="${cls.join(' ')}">${body}</td>`;
    }).join('');
    const desc = entry && entry.desc
      ? `<div class="vg-cdesc">${esc(entry.desc)}</div>` : '';
    return `<tr><th class="vg-cname">${esc(name)}${desc}</th>${cells}</tr>`;
  }).join('');

  const head = groups.map((g) =>
    `<th class="vg-chead">${esc(label(g))}` +
    `<span class="vg-tabn">${g.members.length}</span></th>`).join('');

  // 何を見ればよいかを先に出す。表だけ置かれても、どこが問題かは読み取りにくい。
  const lead = [];
  if (mixedCount) {
    lead.push(notice(`同じグループの中で型・NULL 制約・並び順が揃っていない箇所が ${mixedCount} 件あります` +
      `（${WARN} の印）。SQL が同一でも参照先テーブルの型が違えばこうなるので、` +
      `ロジック差分には出てきません。`));
  }
  if (diffRows) {
    lead.push(notice(`グループ間で型または NULL 制約が揃っていない列が ${diffRows} 件` +
      `あります（色付きのセル。その列でいちばん多い値と違うもの）。` +
      `並び順（#）の違いには色を付けていません` +
      `（列を 1 本足すと以降がまとめてずれ、型の差が埋もれるため）。`));
  }
  if (!lead.length) {
    lead.push(notice('全グループで列名・型・NULL 制約が一致しています。'));
  }

  return lead.join('') +
    `<div class="vg-ctablewrap"><table class="vg-ctable">` +
    `<thead><tr><th class="vg-chead vg-cnamehead">列名</th>${head}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;
}

/** base 1 件分。見出しは外枠（wrapPage）が出すので、ここでは中身だけ。 */
function renderColumnsBase(b, byView) {
  return `<div class="vg-root">${renderColumns(b, byView)}</div>`;
}

/**
 * このファイルが出す markup に対応する CSS。
 * markdown.js の memoCss() と同じ考え方で、クラス名を付けている側に置く。
 * 配る 1 枚は viewlgc_group_css が chromeCss() と連結して作る。
 */
function columnsCss() {
  return [
    // 表は列（グループ）が増えると横に伸びる。カードごとではなく表だけ流す。
    `.vg-ctablewrap{overflow-x:auto}`,
    `.vg-ctable{border-collapse:collapse;font-size:12px}`,
    `.vg-chead{position:sticky;top:0;z-index:1;padding:6px 12px;` +
      `border:1px solid #D0D7DE;background:#F6F8FA;color:#24292F;` +
      `font-weight:600;text-align:left;white-space:nowrap}`,
    `.vg-cnamehead{min-width:180px}`,
    `.vg-cname{padding:5px 12px;border:1px solid #D0D7DE;text-align:left;` +
      `vertical-align:top;font-weight:600;color:#24292F;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-cdesc{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `font-weight:400;color:#57606A;white-space:normal;max-width:320px}`,
    `.vg-ccell{padding:5px 12px;border:1px solid #D0D7DE;vertical-align:top;` +
      `white-space:nowrap;color:#24292F;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    // 並び順と NULL 制約。型より弱い情報なので、小さく下に添える。
    `.vg-cmeta{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `color:#57606A}`,
    // 基準と違う型。差分の「追加」側と同じ地色で、目が同じ意味に慣れるようにする。
    `.vg-cdiff{background:#dfe7d2}`,
    `.vg-cnone{color:#8C959F;background:#FAFAFA}`,
    // グループ内で揃っていない箇所。基準との差より強い警告なので枠で示す。
    `.vg-cmix{box-shadow:inset 0 0 0 2px #D4A72C}`,
    `.vg-cwarn{position:relative;margin-left:6px;color:#9A6700;cursor:help}`,
    `.vg-cwarn::after{content:attr(data-tip);display:none;position:absolute;z-index:20;` +
      `left:0;top:calc(100% + 5px);width:max-content;max-width:340px;` +
      `padding:6px 10px;border-radius:6px;background:#24292F;color:#fff;` +
      `font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;` +
      `white-space:pre-wrap;text-align:left;` +
      `box-shadow:0 2px 10px rgba(0,0,0,.30);pointer-events:none}`,
    `.vg-cwarn:hover::after{display:block}`,
  ].join('\n');
}

module.exports = {
  renderColumns, renderColumnsBase, columnsCss,
  groupColumns, columnOrder, cellInfo, mixedTip, nullText, majority,
};
