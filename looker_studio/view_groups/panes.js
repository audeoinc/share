'use strict';
/**
 * ロジック差分の**ペインだけ**を作る。タブや外枠は作らない。
 *
 * `render_groups.js` から切り出したもの。切り出した理由はサイズで、
 * **JS UDF の本体は 1 個 32 KB まで**という BigQuery の上限に
 * `viewlgc_render` が収まらなくなりかけた（最小化後 27.0 KB = 上限の 90%）。
 *
 * 嵩の内訳はこうだった（最小化後）。
 *   render_groups.js        13.4 KB  タブ・パラメータ表・外枠
 *   render.js（同梱）        8.7 KB  ペインの markup と SQL の色付け
 *   diff.js（同梱）          4.7 KB  行単位の差分
 *   chrome.js                3.4 KB  共通
 *
 * **差分エンジン（diff.js / render.js）とタブは、互いを呼ばない。** 境目は
 * 「1 組 = 1 ペイン分の HTML」の 1 か所だけ（`render_groups.js` の `tabs()` が
 * `pair()` と `renderFragment1()` を呼んでいたところ）なので、そこで切った。
 *
 * 分け方は erd / page と同じ。**JS UDF から別の UDF は呼べない**ので、
 * つなぐのは SQL の仕事になる。
 *
 *   viewlgc_panes(analysis, options, ref_index)  → ペインの JSON
 *   viewlgc_render(analysis, panes_json, …)      → それを嵌めた HTML
 *
 * **ペインの並びは render 側の `tabs()` と同じ規則で作る。** あちらは
 * 「基準を除いた残りを `MAX_TABS` 件まで」で並べるので、こちらも同じに
 * そろえてある。添字で対応するため、**どちらかだけ変えると中身がずれる**
 * （ずれは `node check_sql.mjs` と `node preview.mjs` が見張る）。
 */

const { splitLines, build2Way } = require('../ddl_diff_viz/src/lib/diff');
const { renderFragment1, renderFragment2 } = require('../ddl_diff_viz/src/lib/render');
const { MAX_TABS, esc, label, kindText } = require('./chrome.js');

/**
 * ペインの副題を差し替える。
 * render.js は 2 ペインを (before)/(after)、3 ペインを (base)/(after)/(reference) と
 * 出すが、ロジック系統の間に時間的な前後関係も優劣もないので誤解を招く。
 * ベンダリングした render.js は書き換えたくないため、出力側で置換する。
 */
function relabelPanes(html, subs) {
  let i = 0;
  return html.replace(
    /(<span style="[^"]*font-weight:400;">)\((?:before|after|base|reference)\)(<\/span>)/g,
    (m, open, close) => {
      const sub = subs[i++];
      return sub == null ? m : open + esc(sub) + close;
    }
  );
}

/** 「3 View」のような、系統の規模が分かる副題。 */
const paneSub = (g) => `${g.members.length} View`;

/**
 * SQL 中の `{{Pn}}` に出す吹き出しの中身。
 * 種別と suffix ごとの実際の値を並べる（末尾の一覧まで目を往復させないため）。
 */
function paramTips(g) {
  const tips = {};
  for (const p of g.params) {
    tips[p.name] = `${p.name}: ${kindText(p.kind)}\n` +
      Object.entries(p.values).map(([s, v]) => `${s || '(suffix なし)'} = ${v}`).join('\n');
  }
  return tips;
}

/** 基準グループと 1 グループの 2 ペイン比較。 */
function pair(baseGroup, other, opts) {
  return relabelPanes(
    renderFragment2(
      label(baseGroup), label(other),
      build2Way(splitLines(baseGroup.sql), splitLines(other.sql)),
      opts,
      { left: paramTips(baseGroup), right: paramTips(other) }
    ),
    [`基準 / ${paneSub(baseGroup)}`, paneSub(other)]
  );
}

/**
 * base 1 件 × 基準 1 つ分のペイン。
 *
 * 返すのは 2 つのうち片方だけ。
 *   panes  比較相手がいる場合。**基準を除いた残りの順**で、MAX_TABS 件まで
 *   single 1 グループの場合。比較しないので SQL を 1 ペインだけ出す
 *
 * **全 View が同一ロジックなら比較しない。** 同じ SQL を左右に並べても読む人が
 * 得るものが無いため。差分の色分け（+ / − マーカー・行背景・ハッチ）は出番が
 * 無いので付かず、行番号と SQL だけになる。
 */
function buildPanes(b, opts, refIndex) {
  const groups = (b && b.groups) || [];
  if (!groups.length) return { panes: [] };
  const ri = Math.min(Math.max(refIndex | 0, 0), groups.length - 1);
  const base = groups[ri];
  const others = groups.filter((_, i) => i !== ri);
  if (!others.length) {
    return {
      single: renderFragment1(
        label(base), paneSub(base), splitLines(base.sql), opts, paramTips(base)),
    };
  }
  return {
    panes: others.slice(0, MAX_TABS).map((g) => pair(base, g, opts)),
  };
}

module.exports = {
  buildPanes, pair, relabelPanes, paneSub, paramTips,
};
