'use strict';
/**
 * カードの外枠まわりで、差分側と ERD 側の両方が使う部品。
 *
 * 分けてあるのは UDF のサイズのため。ERD は差分（diff.js / render.js）を
 * 使わないので、共通部分をここに置いておけば ERD 側の UDF に差分エンジンを
 * 積まずに済む。インラインのコード ブロブは 1 個あたり 32 KB までしか無い。
 */

const MAX_TABS = 12; // 静的 CSS が面倒を見るタブ数の上限
// SQL タブは **base の View を 1 本残らず** 出すためのもの。ロジックが同じ
// View も別グループの View も、全部ここに並ぶ（並びは suffix の文字数 →
// アルファベット順）。だから上限は「割れ方」ではなく **base の View 数**で
// 決まり、リージョンを足すたびに伸びる。
//
// 上げても UDF のコード量は変わらない（規則はループで作る）。描画メモリにも
// ほぼ効かない（144 View で 0.46 MB。比較ペインの 13 MB に対して小さい）。
//
// **効くのは配る CSS の大きさ。** これは viewlgc_group_css の**定義本文**として
// BigQuery に載り、本文は 32 KB までしか無い（JavaScript でも SQL でも同じ）。
// 24 → 128 に上げたときに 43,771 バイトになり、CREATE が
//   Definition body too long 43771; max allowed 32768 bytes
// で落ちた。いまは groupRule() が同じ飾りの規則を ',' で束ねるので 1 枚
// あたり約 89 バイト。固定ぶんが約 20 KB あるので **載るのは 140 枚あたりが
// 頭打ち**（128 枚で 31,381 B ／ 残り 1,387 B）。
//
// **上げるときは node build_udf.mjs が本文の大きさを見張る。** 超えると生成が
// 失敗して view_group_html.sql を書き出さないので、BigQuery まで持って行けない。
// それ以上を出したくなったら、CSS を分割して複数の関数に載せ group_css が
// 連結する形にする（本文の上限は関数ごとなので、分ければ天井が上がる）。
//
// 保存されるバイト数にも効く。SQL タブは基準の行ごとに毎回描かれるので
// base 全体では ×行数（max_ref_rows、既定 24）になる。
const MAX_SQL_TABS = 128;
// note タブの上段（View の description）のタブ数の上限。description が
// 何種類に割れているかで決まる。全 View が別々の説明を持てば View 数まで
// 増えうるが、実際にそこまで割れることはまず無いので中間を取ってある。
const MAX_DESC_TABS = 16;
// note タブのラベル（View の labels）のタブ数の上限。タブが出るのは base の
// 中でラベルが割れているときだけで、そのときも「揃っている多数派 ＋ 外れた
// 数本」の形になる。description ほど散らばらないので少なめでよい。
const MAX_LABEL_TABS = 8;
/**
 * 外側のタブ。左から並ぶ順で、先頭が既定の表示。
 * 数と順序は chromeCss() の規則と対で決まるので、ここだけを直せば両方動く。
 */
// 並びを変えるとパネルの中身と番号の対応が変わるが、CSS は番号ごとに対称な
// 規則を出すだけで見出しも中身も知らないので、貼り替えの順序は問わない。
const OUTER_TABS = ['note', 'カラム定義', '参照関係', 'ロジック差分', 'SQL'];

/**
 * 外側タブの CSS を用意しておく枚数。**いま並べる枚数より多くしてある。**
 *
 * テンプレートの CSS は手で貼り、カードは日次で作り直す。順序はいつも
 * 「カードが先・CSS が後」になるので、タブを 1 枚足すと、貼り替えるまでの間
 * **タブは出るのに中身が出ない**（そのタブを開く規則が CSS に無い）。
 * 押せて反転もしない空欄になるので、故障と見分けが付かない。実際に 1 度出した。
 *
 * 使う予定のない番号の規則を出しておいても、その要素が無ければ何も起きない。
 * 2 行 × 数枚ぶんの CSS と引き換えに、次にタブを足したときは**カードだけ
 * 貼り替えれば動く**（CSS の貼り替えは色や体裁を変えたときだけになる）。
 */
const MAX_OUTER_TABS = 8;

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

/**
 * 配布 CSS の世代。**カードが新しい CSS の規則を必要とするようになったら上げる。**
 *
 * この画面は CSS を手で貼り、カードは日次で作り直す。順序はいつも
 * 「カードが先・CSS が後」なので、その間カードは**新しい markup ＋ 古い CSS**で
 * 表示される。タブ 1 枚ぶんの追加なら MAX_OUTER_TABS の余分な規則で吸収できるが、
 * **クラスの頭ごと増える機能（note タブの description のタブなど）は吸収できない。**
 * そのときの見え方は
 *   ・パネルが全部同時に出る（.vg-dpanel{display:none} が無い）
 *   ・ラジオの丸がそのまま見える（隠す規則が無い）
 *   ・押しても何も起きない（:checked の規則が無い）
 * で、**故障と見分けが付かない**。実際に 2 度この形で表に出た（SQL タブと
 * note タブ）。原因が「CSS を貼っていない」であることは画面から読み取れない。
 *
 * そこでカード側に世代の印を埋め、**その世代の CSS だけが消せる**ようにする。
 *   カード  <div class="vg-cssgen5" style="…">CSS が古い</div>
 *   CSS     .vg-cssgen5{display:none}
 * 古い CSS にはこの規則が無いので、案内がそのまま出る。style 属性で直に
 * 飾ってあるので、CSS が 1 行も効いていなくても読める形で出る。
 *
 * 世代 4 ＝ note タブのラベル（.vg-lb*）。
 * 世代 5 ＝ 基準の見出し（.vg-refhead / .vg-refname / .vg-refnote）。基準を
 *          選ぶタブ（.vg-b*）を廃して行に分けたので、規則ごと入れ替わった。
 * 世代 6 ＝ 比較タブの地の色（.vg-tab）。**構造は変わっていない**が、貼り直さ
 *          ないと未選択が白のままで、選択中と見分けが付かない。切り替え自体は
 *          動くので、画面からは「直っていない」としか読めない——世代を上げない
 *          と、貼り忘れと未修正が区別できない。
 * 世代 7 ＝ 選択中の比較タブを白から比較ペインの薄い緑に。これも見た目だけの
 *          変更だが、6 を貼った直後に 7 が出たので、**どちらを貼ったか**が画面
 *          から分かる必要があった。見た目だけの変更でも世代は上げる。
 * 世代 8 ＝ SQL タブの上限を 24 → 128（.vg-sr25… 以降の規則が増えた）。
 *          貼り直さないと 25 枚目から先が**押しても切り替わらない**。これは
 *          まさに「故障と見分けが付かない」形。
 * 世代 9 ＝ note の見出しをリージョンごとに束ねる（.vg-nreg / .vg-nregname）。
 *          貼り直さないと区切り線が出ず、リージョン名と suffix が地続きに
 *          並んで**どこで切れているのか読めない**。
 */
const CSS_GEN = 9;

/**
 * CSS が古いときだけ出る案内。上の CSS_GEN を参照。
 * 飾りは style 属性に直に書く（この案内が出る場面では CSS が当てにならない）。
 */
function cssGuard() {
  return `<div class="vg-cssgen${CSS_GEN}" style="margin:0 0 10px;` +
    `padding:8px 12px;border:1px solid #D4A72C;border-radius:6px;` +
    `background:#FFF8C5;color:#7D4E00;` +
    `font:12px/1.6 'Roboto','Segoe UI',system-ui,sans-serif">` +
    `このカードには新しい CSS（世代 ${CSS_GEN}）が要ります。` +
    `template_style.html を貼り直してください。` +
    `貼り替えるまで、タブが正しく出ません` +
    `（切り替わらない・中身が全部同時に出る・選択中が分からない）。</div>`;
}

/**
 * 同じ飾りを持つ添字つきの規則を **1 本にまとめる**。
 *
 *   まとめない  .vg-sr1:checked ~ .vg-spanels > .vg-sp1{display:block}
 *               .vg-sr2:checked ~ .vg-spanels > .vg-sp2{display:block}   … × N
 *   まとめる    .vg-sr1:checked ~ .vg-spanels > .vg-sp1,
 *               .vg-sr2:checked ~ .vg-spanels > .vg-sp2{display:block}
 *
 * 配る CSS は `viewlgc_group_css` の**本文として BigQuery に載る**。関数の
 * 定義本文は 32 KB までで、これは JavaScript でも SQL でも同じ（SQL なら
 * 上限が無いと思って SQL 側に焼いた経緯があるが、そちらでも当たる）。
 * 添字ごとに飾りを書くと飾りの文字列が添字の数だけ複製されるので、
 * **タブの上限を上げたときにいちばん効くのがここ**。
 *
 * セレクタの形（'兄弟 ~ 親 > 子'）と空白は動かさない。この viz で
 * radio + :checked が動くと確かめたときの形がこれで、',' で束ねても
 * 一つひとつのセレクタは変わらない。
 *
 * @param {number} n        添字の上限（1 起点）
 * @param {(i:number)=>string|string[]} selector 添字 i のセレクタ
 * @param {string} decl     '{' と '}' を除いた飾り
 */
function groupRule(n, selector, decl) {
  const sels = [];
  for (let i = 1; i <= n; i++) {
    const s = selector(i);
    if (Array.isArray(s)) for (const x of s) sels.push(x);
    else sels.push(s);
  }
  return sels.join(',') + '{' + decl + '}';
}

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

function header(base, viewCount, groupCount, unmatched, labelSplit) {
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
    // ラベルが base の中で割れているのも同じたぐいの情報。値そのものは
    // note タブに出すが、**割れていることだけは note を開かずに拾えるように
    // する。** 揃っているときは何も出さない（揃っているのが普通なので、
    // 全カードに 1 個ずつバッジが増えても読む手掛かりにならない）。
    (labelSplit ? badge('ラベル不一致', '#9A6700', '#FFF8C5') : '') +
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
 * note のパネルの中身は呼び出し側が組み立てて渡す（viewdesc.js の renderNote）。
 * ここで作らないのは、description の段がタブを持つことがあり、その markup と
 * CSS を 1 か所にまとめておきたいから。渡されなければ目印だけを置く。
 * **メモの本体はどちらの経路でも入らない。** 目印（NOTE_MARK）を置くだけで、
 * 中身はビューが差し替える（シートを直した内容がその場で出るようにするため）。
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
 * @param {string} noteHtml note タブの中身（description の段 ＋ 目印）。
 *                         省略したら目印だけ
 * @param {object} base 解析結果の base 1 件分。見出しと id の種に使う
 * @param {boolean} labelSplit base の中でラベルが割れているか。見出しの
 *                             バッジに出す。値そのものは note タブの担当
 */
function wrapPage(diffHtml, erdHtml, colsHtml, sqlHtml, noteHtml, base, labelSplit) {
  const b = base || {};
  const id = 'vgo' + hashId(b.base || '');
  const note = noteHtml == null || noteHtml === '' ? NOTE_MARK : String(noteHtml);
  // OUTER_TABS と同じ並び
  const bodies = [`<div class="vg-root">${note}</div>`, colsHtml, erdHtml,
    diffHtml, sqlHtml];
  const radios = OUTER_TABS.map((_, i) =>
    `<input class="vg-or vg-or${i + 1}" type="radio" name="${id}"` +
    ` id="${id}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tabs = OUTER_TABS.map((t, i) =>
    `<label class="vg-otab vg-ot${i + 1}" for="${id}-${i + 1}">${esc(t)}</label>`).join('');
  const panels = OUTER_TABS.map((_, i) =>
    `<div class="vg-opanel vg-op${i + 1}">${bodies[i] || ''}</div>`).join('');
  const head = b.base
    ? header(b.base, b.viewCount, (b.groups || []).length, b.unmatched,
      labelSplit) : '';
  // 世代の案内はいちばん上。CSS が古ければ出て、合っていれば消える。
  // ラジオより前に置いてよい（:checked ~ が見るのはラジオの「後ろ」だけ）。
  return `<div class="vg-outer">${cssGuard()}${radios}` +
    `<div class="vg-otablist">${head}${tabs}</div>` +
    `<div class="vg-opanels">${panels}</div></div>`;
}

module.exports = {
  MAX_TABS, MAX_SQL_TABS, MAX_DESC_TABS, MAX_LABEL_TABS,
  MAX_OUTER_TABS, OUTER_TABS,
  NOTE_MARK, CSS_GEN, cssGuard, groupRule,
  esc, hashId, label, badge, header, notice, KIND_TEXT, kindText, wrapPage,
};
