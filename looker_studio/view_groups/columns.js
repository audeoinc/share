'use strict';
/**
 * View のカラム定義（INFORMATION_SCHEMA.COLUMNS）を 1 枚の表にする。
 *
 *   1 行 = 1 列名、1 列 = 1 ロジック グループ。セルはその型。
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
 */

const { esc, label, notice, referenceIndex } = require('./chrome.js');

/** 型が違うことを示す印。セルの中に置く。 */
const WARN = '⚠';

/**
 * グループ 1 つ分の「列名 → その列について分かっていること」。
 *
 * 同じグループでも View ごとに列が違いうるので、型は View ぶん貯めておく。
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
        e = { name: c.n, desc: '', order: k, types: [] };
        out.set(c.n, e);
      }
      // 説明は列ごとに 1 つ。最初に見つかったものを採る（View ごとに違うことは
      // 基本的に無く、あっても表を横に広げてまで並べる情報ではない）。
      if (!e.desc && c.d) e.desc = c.d;
      e.types.push({ suffix: suffix, type: c.t });
    }
  }
  return out;
}

/**
 * 表の行の並び。基準グループの順を土台にして、そこに無い列を後ろに足す。
 * 基準に合わせるのは、読む人が基準の View を見ながら突き合わせるため。
 */
function columnOrder(groups, maps, refIndex) {
  const seen = new Set();
  const out = [];
  const push = (m) => {
    const rows = [...m.values()].sort((a, b) => a.order - b.order);
    for (const e of rows) {
      if (!seen.has(e.name)) { seen.add(e.name); out.push(e.name); }
    }
  };
  push(maps[refIndex]);
  for (let i = 0; i < groups.length; i++) if (i !== refIndex) push(maps[i]);
  return out;
}

/** そのグループでの型。食い違っていれば全部返す。 */
function cellTypes(entry, memberCount) {
  if (!entry) return { text: null, kinds: [], mixed: false };
  const kinds = [];
  for (const t of entry.types) if (kinds.indexOf(t.type) < 0) kinds.push(t.type);
  // 型が割れているか、そもそも列を持たない View がグループ内にあるか
  const mixed = kinds.length > 1 || entry.types.length !== memberCount;
  return { text: kinds.join(' / '), kinds: kinds, mixed: mixed };
}

/** グループ内で食い違ったときの内訳。tooltip に出す。 */
function mixedTip(entry, g) {
  const lines = entry.types.map((t) => `${t.suffix} = ${t.type}`);
  const have = entry.types.map((t) => t.suffix);
  for (let i = 0; i < (g.members || []).length; i++) {
    const suffix = (g.suffixes && g.suffixes[i]) || g.members[i].viewName;
    if (have.indexOf(suffix) < 0) lines.push(`${suffix} = (この列を持たない)`);
  }
  return lines.join('\n');
}

/**
 * base 1 件分のカラム定義の表。
 * @param {object} b               解析結果の base 1 件分
 * @param {object} byView          { View 名: [{ n: 列名, t: 型, d: 説明 }] }
 * @param {object} opts            referenceIndex を見る
 */
function renderColumns(b, byView, opts) {
  const groups = b.groups || [];
  if (!groups.length) return notice('View が見つかりません。');
  const refIndex = referenceIndex(b, opts || {});
  const maps = groups.map((g) => groupColumns(g, byView || {}));
  const order = columnOrder(groups, maps, refIndex);
  if (!order.length) {
    return notice('カラム定義を取得できませんでした。' +
      'INFORMATION_SCHEMA.COLUMNS から列が読めているか確認してください。');
  }

  // 並びは基準グループが先頭。差分側・参照関係側と同じ順にそろえる。
  const order2 = [refIndex].concat(groups.map((_, i) => i).filter((i) => i !== refIndex));

  let diffCount = 0;
  let mixedCount = 0;
  const rows = order.map((name) => {
    const refCell = cellTypes(maps[refIndex].get(name), groups[refIndex].members.length);
    const entry = maps[refIndex].get(name) ||
      order2.map((i) => maps[i].get(name)).filter((e) => e)[0];
    const cells = order2.map((i, pos) => {
      const g = groups[i];
      const e = maps[i].get(name);
      const c = cellTypes(e, g.members.length);
      const cls = ['vg-ccell'];
      if (!c.text) cls.push('vg-cnone');
      // 基準と違う型・基準に無い列。基準の列そのものには印を付けない。
      else if (pos > 0 && c.text !== refCell.text) { cls.push('vg-cdiff'); diffCount++; }
      if (c.mixed) { cls.push('vg-cmix'); mixedCount++; }
      const body = c.text
        ? esc(c.text) + (c.mixed
          ? `<span class="vg-cwarn" data-tip="${esc(mixedTip(e, g))}">${WARN}</span>` : '')
        : '—';
      return `<td class="${cls.join(' ')}">${body}</td>`;
    }).join('');
    const desc = entry && entry.desc
      ? `<div class="vg-cdesc">${esc(entry.desc)}</div>` : '';
    return `<tr><th class="vg-cname">${esc(name)}${desc}</th>${cells}</tr>`;
  }).join('');

  const head = order2.map((i, pos) =>
    `<th class="vg-chead${pos === 0 ? ' vg-cref' : ''}">` +
    (pos === 0 ? `<span class="vg-tbadge">基準</span>` : '') +
    `${esc(label(groups[i]))}<span class="vg-tabn">${groups[i].members.length}</span></th>`).join('');

  // 何を見ればよいかを先に出す。表だけ置かれても、どこが問題かは読み取りにくい。
  const lead = [];
  if (mixedCount) {
    lead.push(notice(`同じグループの中で列の型が揃っていない箇所が ${mixedCount} 件あります` +
      `（${WARN} の印）。SQL が同一でも参照先テーブルの型が違えばこうなるので、` +
      `ロジック差分には出てきません。`));
  }
  if (diffCount) {
    lead.push(notice(`基準グループと型が違う箇所が ${diffCount} 件あります（色付きのセル）。`));
  }
  if (!lead.length) lead.push(notice('全グループで列名も型も一致しています。'));

  return lead.join('') +
    `<div class="vg-ctablewrap"><table class="vg-ctable">` +
    `<thead><tr><th class="vg-chead vg-cnamehead">列名</th>${head}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`;
}

/** base 1 件分。見出しは外枠（wrapPage）が出すので、ここでは中身だけ。 */
function renderColumnsBase(b, byView, opts) {
  return `<div class="vg-root">${renderColumns(b, byView, opts)}</div>`;
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
    // 基準グループの見出し。差分側の基準タブと同じ色にそろえる。
    `.vg-cref{background:#fbeded;border-color:#efb6b6}`,
    `.vg-cnamehead{min-width:180px}`,
    `.vg-cname{padding:5px 12px;border:1px solid #D0D7DE;text-align:left;` +
      `vertical-align:top;font-weight:600;color:#24292F;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-cdesc{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `font-weight:400;color:#57606A;white-space:normal;max-width:320px}`,
    `.vg-ccell{padding:5px 12px;border:1px solid #D0D7DE;vertical-align:top;` +
      `white-space:nowrap;color:#24292F;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
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
  groupColumns, columnOrder, cellTypes, mixedTip,
};
