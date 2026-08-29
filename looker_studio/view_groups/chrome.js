'use strict';
/**
 * カードの外枠まわりで、差分側と ERD 側の両方が使う部品。
 *
 * 分けてあるのは UDF のサイズのため。ERD は差分（diff.js / render.js）を
 * 使わないので、共通部分をここに置いておけば ERD 側の UDF に差分エンジンを
 * 積まずに済む。インラインのコード ブロブは 1 個あたり 32 KB までしか無い。
 */

const MAX_TABS = 12; // 静的 CSS が面倒を見るタブ数の上限

/**
 * 外側のタブ。左から並ぶ順で、先頭が既定の表示。
 * 数と順序は chromeCss() の規則と対で決まるので、ここだけを直せば両方動く。
 */
const OUTER_TABS = ['note', 'ロジック差分', '参照関係'];

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
 * どのグループを基準にするか。範囲外や数値でない指定は既定（0）に戻す。
 * 中途半端に丸めると、指定を間違えたときに別の基準の絵が出て気づけない。
 * 差分側と ERD 側で規則が違うと、同じレコードなのに別の系統が基準に見える。
 */
function referenceIndex(b, opts) {
  const n = (b.groups || []).length;
  const ri = Math.trunc(Number((opts || {}).referenceIndex));
  return Number.isFinite(ri) && ri >= 0 && ri < n ? ri : 0;
}

/**
 * メモ・ロジック差分・参照関係を外側のタブで束ねる。
 *
 * 1 レコードに全部入れるので、Looker Studio のコントロール（base / ref_label）は
 * どのタブにも同じように効く。別のチャートに分けると、コントロールを
 * 何組もそろえる必要が出て、片方だけずれた状態を作れてしまう。
 *
 * メモのパネルには本体ではなく目印（NOTE_MARK）を置く。上の説明のとおり、
 * メモだけは作り置きではなくビューの中で作るため。
 *
 * 内側のタブとはクラスを分けてある。同じクラスだと内側のラジオが外側の
 * :checked ~ に引っかかり、片方を押すともう片方も切り替わる。
 */
function wrapPage(diffHtml, erdHtml, seed) {
  const id = 'vgo' + hashId(seed);
  const bodies = [NOTE_MARK, diffHtml, erdHtml];
  const radios = OUTER_TABS.map((_, i) =>
    `<input class="vg-or vg-or${i + 1}" type="radio" name="${id}"` +
    ` id="${id}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tabs = OUTER_TABS.map((t, i) =>
    `<label class="vg-otab vg-ot${i + 1}" for="${id}-${i + 1}">${esc(t)}</label>`).join('');
  const panels = OUTER_TABS.map((_, i) =>
    `<div class="vg-opanel vg-op${i + 1}">${bodies[i] || ''}</div>`).join('');
  return `<div class="vg-outer">${radios}` +
    `<div class="vg-otablist">${tabs}</div>` +
    `<div class="vg-opanels">${panels}</div></div>`;
}

module.exports = {
  MAX_TABS, OUTER_TABS, NOTE_MARK, esc, hashId, label, badge, header, notice,
  KIND_TEXT, kindText, referenceIndex, wrapPage,
};
