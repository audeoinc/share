'use strict';
/**
 * カードの外枠まわりで、差分側と ERD 側の両方が使う部品。
 *
 * 分けてあるのは UDF のサイズのため。ERD は差分（diff.js / render.js）を
 * 使わないので、共通部分をここに置いておけば ERD 側の UDF に差分エンジンを
 * 積まずに済む。インラインのコード ブロブは 1 個あたり 32 KB までしか無い。
 */

const MAX_TABS = 12; // 静的 CSS が面倒を見るタブ数の上限
// 基準タブ（ロジック差分の中）も静的 CSS で面倒を見る。実際に載せる枚数は
// 下の予算で決めるので、これは CSS を用意しておく上限。
const MAX_REF_TABS = 12;
// SQL タブ（View ごとの素の SQL）のタブ数の上限。ここだけグループではなく
// View 単位なので、同じ base でも枚数が桁ひとつ多くなりうる。多めに取ってある。
const MAX_SQL_TABS = 24;
// 1 レコードに載せる差分の上限。
//
// **これは「重くしない」ための値ではなく、「行が壊れない」ための値。**
// 基準を 1 つ増やすたびに比較ペインがグループ数ぶん増える（全部で G×(G−1) 枚）
// ので、グループが極端に多い base が 1 つ紛れ込むと 1 行が BigQuery の上限
// （クエリ結果の 1 行 100 MB）を超え、**日次の INSERT ごと落ちる**。カードが
// 欠けるよりパイプラインが止まるほうが困るので、そこだけは止める。
//
// 40 MB にしてあるのは、100 MB に対して余裕を取りつつ、実データでは絶対に
// 当たらない位置に置くため。実測（あるプロジェクトの全 base）で、基準 1 つ
// ぶんの最大が 690 KB・大半は 490 KB 以下だった。G=6 でも 4 MB 程度で、
// 40 MB には 1 桁足りない。
//
// 以前は 600 KB にしていて、3 グループ × 500 行の SQL で通常の運用のまま
// 当たっていた。「基準タブが 1 枚しか出ない」という、故障と見分けの付かない
// 形で表に出る。見積もりで決めた値がこうなるので、実測に合わせてある。
const REF_BUDGET = 40 * 1024 * 1024;

/**
 * 外側のタブ。左から並ぶ順で、先頭が既定の表示。
 * 数と順序は chromeCss() の規則と対で決まるので、ここだけを直せば両方動く。
 */
// 並びを変えるとパネルの中身と番号の対応が変わるが、CSS は番号ごとに対称な
// 規則を出すだけで見出しも中身も知らないので、貼り替えの順序は問わない。
const OUTER_TABS = ['note', 'カラム定義', '参照関係', 'ロジック差分', 'SQL'];

/**
 * メモの差し込み口。
 *
 * カードは日次で作り置きするが、メモはビューの中で毎回作る（シートを直した
 * 内容がその場で出るようにするため）。作り置きの側に本体を埋めることが
 * できないので、外枠だけ先に作って目印を置いておき、ビューが
 *   REPLACE(diff_html, '<!--VG_NOTE-->', note_html)
 * で差し替える。目印の文字列は build_table.sql と一致していなければならず、
 * 食い違っていないかは node check_sql.mjs が見張る。
 */
const NOTE_MARK = '<!--VG_NOTE-->';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** ラジオの id / name をレコードごとに一意にするための短いハッシュ。 */
function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * ペイン見出し。通常は同じロジックを持つ suffix の列記。
 * suffix を認識できなかった View は suffix が null なので、View 名で出す。
 */
const label = (g) => g.suffixes
  .map((s, i) => s || (g.members[i] && g.members[i].viewName) || '(suffix なし)')
  .join(', ');

function badge(txt, fg, bg) {
  return `<span class="vg-badge" style="color:${fg};background:${bg}">${esc(txt)}</span>`;
}

function header(base, viewCount, groupCount, unmatched) {
  const warn = groupCount > 1;
  return (
    `<div class="vg-header">` +
    `<span class="vg-title">${esc(base)}</span>` +
    badge(`${viewCount} View`, '#57606A', '#EAEEF2') +
    badge(`${groupCount} グループ`,
      warn ? '#9A6700' : '#1A7F37',
      warn ? '#FFF8C5' : '#DAFBE1') +
    // 命名規則から外れていること自体が情報なので、一覧で拾えるようにする
    (unmatched ? badge('suffix 未認識', '#9A6700', '#FFF8C5') : '') +
    `</div>`
  );
}

function notice(text) {
  return `<div class="vg-notice">${esc(text)}</div>`;
}

/** トークン種別の表示名。生の kind をそのまま出しても読めないため。 */
const KIND_TEXT = {
  entity: '実体名', string: '値（文字列）', number: '値（数値）',
  ident: '名前', quoted: '名前', keyword: '予約語', punct: '記号', comment: 'コメント',
};
const kindText = (k) => KIND_TEXT[k] || k;

/**
 * メモ・カラム定義・参照関係・ロジック差分・SQL を外側のタブで束ねる。
 *
 * 1 レコードに全部入れるので、Looker Studio のコントロール（base / ref_label）は
 * どのタブにも同じように効く。別のチャートに分けると、コントロールを
 * 何組もそろえる必要が出て、片方だけずれた状態を作れてしまう。
 *
 * メモのパネルには本体ではなく目印（NOTE_MARK）を置く。上の説明のとおり、
 * メモだけは作り置きではなくビューの中で作るため。
 *
 * 見出し（base 名・View 数・グループ数）はタブと同じ帯に入れて、まとめて
 * スクロールに追従させる。差分側（renderBase）と参照関係側（renderErdBase）は
 * それぞれ自分でも見出しを出すが、単体で使うときのためのもので、束ねたときは
 * CSS で隠してこの 1 枚に集約する。
 *
 * 見出しは .vg-otablist の「中」に置く。外に出して包むと、選択中のタブを塗る
 * 規則が :checked ~ .vg-otablist > .vg-otN（子）ではなく子孫になる。
 * この viz で動くと確認できているのは子のほうで（templated_record/samples/
 * 07_radio_tabs_test.html）、子孫に変えたら実機で反転しなくなった。
 * 並びは .vg-otablist を flex-wrap にして、見出しだけ 1 行占有させる。
 *
 * ラジオは .vg-outer の直下。ここに置いてあれば .vg-otablist も .vg-opanels も
 * 後ろに続く兄弟になり、どちらの規則も「兄弟 > 子」で書ける。
 *
 * 内側のタブとはクラスを分けてある。同じクラスだと内側のラジオが外側の
 * :checked ~ に引っかかり、片方を押すともう片方も切り替わる。
 *
 * @param {object} base 解析結果の base 1 件分。見出しと id の種に使う
 */
function wrapPage(diffHtml, erdHtml, colsHtml, sqlHtml, base) {
  const b = base || {};
  const id = 'vgo' + hashId(b.base || '');
  // OUTER_TABS と同じ並び
  const bodies = [`<div class="vg-root">${NOTE_MARK}</div>`, colsHtml, erdHtml,
    diffHtml, sqlHtml];
  const radios = OUTER_TABS.map((_, i) =>
    `<input class="vg-or vg-or${i + 1}" type="radio" name="${id}"` +
    ` id="${id}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tabs = OUTER_TABS.map((t, i) =>
    `<label class="vg-otab vg-ot${i + 1}" for="${id}-${i + 1}">${esc(t)}</label>`).join('');
  const panels = OUTER_TABS.map((_, i) =>
    `<div class="vg-opanel vg-op${i + 1}">${bodies[i] || ''}</div>`).join('');
  const head = b.base
    ? header(b.base, b.viewCount, (b.groups || []).length, b.unmatched) : '';
  return `<div class="vg-outer">${radios}` +
    `<div class="vg-otablist">${head}${tabs}</div>` +
    `<div class="vg-opanels">${panels}</div></div>`;
}

module.exports = {
  MAX_TABS, MAX_REF_TABS, MAX_SQL_TABS, REF_BUDGET, OUTER_TABS, NOTE_MARK,
  esc, hashId, label, badge, header, notice, KIND_TEXT, kindText, wrapPage,
};
