'use strict';
/**
 * note タブの中身。**description の箱とメモの箱の二段構え。**
 *
 *   ┌ View の description ─────────┐   ← タブで切り替え（割れているときだけ）
 *   │ …                            │
 *   ├ メモ ────────────────────────┤   ← タブの外。シートの内容がそのまま
 *   │ …                            │
 *   └──────────────────────────────┘
 *
 * 出どころが違うものを 1 本のテキストに繋いでいた頃は、水平線 1 本しか手掛かりが
 * 無く、**どこまでが公式の説明でどこからが運用メモなのかが読み取れなかった。**
 * 更新のされ方も違う（description はデプロイでしか変わらない／シートはその場で
 * 変わる）ので、箱を分けて名前を付けておくほうが素直。
 *
 * **タブが付くのは description の側だけ。** description は View に付いた属性
 * なので、同じ base の中で割れることがある（片方だけ書いてある・文面が古い）。
 * 1 本に畳むとその差が消えるので、割れている数だけタブにして横並びで選べる
 * ようにする。
 *
 * **1 種類のときも見出しは出す。** あれは飾りではなく caption で、
 * 「この description がどの View のものか」は description そのものと同じくらい
 * 大事な情報。隠すと、9 本全部に付いているのか 1 本だけなのかが読めない。
 * ただしそのときはラジオを持たせず <span> にする（押せそうに見えて何も
 * 起きない状態を作らない）。ロジック差分の「基準」タブと同じ扱い。
 *
 * **1 つも設定されていなくても段は出す。** 消すと、未設定なのか取り込みに
 * 失敗しているのか画面から読めず、ただ何も出ない状態になる。
 *
 * メモは base に 1 つしか無いのでタブの外。加えて、メモだけは作り置きではなく
 * ビューの中で差し込む（NOTE_MARK）ので、タブの中に入れるとタブ 1 枚ぶんの
 * markup を SQL 側が組み立てることになってしまう。
 *
 * クラスの頭は .vg-d*。外側（.vg-o*）・基準（.vg-b*）・比較（.vg-r/t/p）・
 * SQL（.vg-s*）のどれとも重ならないようにしてある。重なると一方のラジオが
 * もう一方の :checked ~ に引っかかり、片方を押すともう片方も切り替わる。
 */

const { esc, hashId, notice, MAX_DESC_TABS } = require('./chrome.js');

/**
 * 選択中のタブの塗り。**無彩色にしてある。**
 *
 * 以前は緑（#DAFBE1）だったが、このカードでは緑に既に意味がある ―
 * 差分の「追加」も、見出しの「1 グループ = 全部同じ」バッジも緑。そこへ
 * タブの選択状態が同じ緑で入ると、意味を持った色なのか単に選ばれているだけ
 * なのかが読み分けられない。description のタブは「操作」というより
 * 「いま何を見ているかの表示」なので、彩度を持たせないほうが役割に合う。
 *
 * 塗り＋濃い枠（未選択は白地に #D0D7DE）で、一目で選択中と分かる。
 * 選択中と押せない見出し（.vg-dstatic）で同じ値を使うので、定数にしてある。
 */
const DESC_TAB_ON = 'background:#EAEEF2;border-color:#8C959F;color:#24292F';

/** View 名 → suffix。見出しは View 名ではなく suffix で出す（ほかのタブと同じ）。 */
function suffixByView(b) {
  const out = {};
  const groups = (b && b.groups) || [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const members = g.members || [];
    for (let j = 0; j < members.length; j++) {
      const v = members[j] && members[j].viewName;
      if (v) out[v] = (g.suffixes && g.suffixes[j]) || v;
    }
  }
  return out;
}

/**
 * description の組を、タブに出せる形へ直す。
 *
 * 受け取るのは [{ v: [View 名...], h: '<html>' }]。**Markdown を HTML にするのは
 * SQL 側（viewlgc_markdown）。** JS UDF から別の UDF は呼べないので、ここへは
 * 変換済みのものが来る。同じ文面の View は SQL の GROUP BY で 1 組に畳まれている。
 *
 * 並びは「中身のあるものが先 → View 数の多い順 → 見出し順」。先頭がそのまま
 * 既定で開くタブになるので、いちばん多くの View が持っている説明を出したい。
 * 未設定の組（h が空）は最後に回す。
 */
function descGroups(b, descs) {
  const list = Array.isArray(descs) ? descs : [];
  const suf = suffixByView(b);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i] || {};
    const names = Array.isArray(d.v) ? d.v : (d.v == null || d.v === '' ? [] : [d.v]);
    const labels = names.map((n) => suf[n] || n)
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const html = String(d.h == null ? '' : d.h);
    out.push({
      label: labels.join(', ') || '(View なし)',
      count: names.length,
      html: html,
      empty: html.trim() === '',
    });
  }
  out.sort((x, y) =>
    (x.empty === y.empty ? 0 : x.empty ? 1 : -1) ||
    y.count - x.count ||
    (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
  return out;
}

/**
 * 1 組ぶんの中身。**未設定の組は、空白ではなくそう書く。**
 * 空にすると「設定していない」のか「取れなかった」のか画面から読めない。
 * どの View のことかは上の見出しに出ているので、ここでは繰り返さない。
 */
function descPanel(g) {
  return g.empty ? notice('description が設定されていません。') : g.html;
}

/** タブ 1 枚の見出し。中身は選べても選べなくても同じ形にそろえる。 */
const tabText = (g) => `${esc(g.label)}<span class="vg-tabn">${g.count}</span>`;

/**
 * description の段。**1 つも設定されていなくても段は出す。**
 *
 * 以前は段ごと消していた（「無いものの説明で note タブを埋めない」つもりで）。
 * だが消すと、note タブを開いた人からは
 *   ・description を設定していない
 *   ・取り込みに失敗している
 *   ・そもそもこのカードに description の段が無い世代
 * のどれなのか分からず、**ただ何も出ない**。未設定は未設定と書くほうがよい。
 * 見出しにはどの View のことかも出るので、範囲まで分かる。
 */
function renderDesc(b, descs) {
  const gs = descGroups(b, descs);
  const head = `<div class="vg-nhead">View の description</div>`;
  // 組がひとつも作れないのは「未設定」ではなく「取れなかった」。区別して書く
  // （SQL 側は LEFT JOIN なので、正常なら View の数だけ必ず組ができる）。
  if (!gs.length) {
    return `<div class="vg-nsec">${head}` +
      notice('View の description を取得できませんでした。' +
        'INFORMATION_SCHEMA.TABLE_OPTIONS が読めているか確認してください。') +
      `</div>`;
  }

  // 1 種類のときも見出しは出す。**あれは飾りではなく caption。**
  // 「この description がどの View のものか」は description そのものと同じくらい
  // 大事な情報で、隠すと 9 本全部に付いているのか 1 本だけなのかが読めない。
  //
  // ただしラジオは持たせず <span> にする。<label> のままだと押せそうに見えて
  // 何も起きない。ロジック差分の「基準」タブ（render_groups.js の baseTab）も
  // 同じ理由で <label> ではなく <span> にしてあるので、その扱いにそろえる。
  // 見た目は選択中のタブと同じ ― 実際「いま見ているもの」なので同じで正しい。
  if (gs.length === 1) {
    return `<div class="vg-nsec">${head}` +
      `<div class="vg-dtablist">` +
      `<span class="vg-dtab vg-dstatic">${tabText(gs[0])}</span></div>` +
      `<div class="vg-dbox">${descPanel(gs[0])}</div></div>`;
  }

  const shown = gs.slice(0, MAX_DESC_TABS);
  // ラジオの name / id の種は base だけにしない。**同じ base のカードが 1 枚の
  // ページに 2 つ並ぶと、name が同じラジオは 1 つのグループになる**（HTML の
  // 決まり）ので、片方を選ぶともう片方の選択が外れ、パネルが 1 つも出ない
  // 状態になる。1 レコード 1 カードの本番では起きないが、プレビューでは
  // 実際にそうなって「タブは出るのに中身が空」になった。組み分けまで
  // 種に入れておけば、中身の違うカードは別のグループになる。
  // SQL タブ（sqltext.js）も同じ理由で View 名まで種に入れてある。
  const id = 'vgd' + hashId(((b && b.base) || '') + '|' +
    gs.map((g) => g.label).join('|'));
  const radios = shown.map((_, i) =>
    `<input class="vg-dr vg-dr${i + 1}" type="radio" name="${id}"` +
    ` id="${id}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tablist = shown.map((g, i) =>
    `<label class="vg-dtab vg-dt${i + 1}" for="${id}-${i + 1}">` +
    `${tabText(g)}</label>`).join('');
  const panels = shown.map((g, i) =>
    `<div class="vg-dpanel vg-dp${i + 1}">${descPanel(g)}</div>`).join('');
  // 打ち切ったときは、なぜ選べないのかを出す。タブが足りないだけだと、
  // 故障なのか設計なのか読み取れない。
  const over = gs.length > shown.length
    ? notice(`description が多いため先頭 ${MAX_DESC_TABS} 種類のみ出しています` +
      `（全 ${gs.length} 種類）。`)
    : '';

  return `<div class="vg-nsec">${head}${over}` +
    `<div class="vg-dtabs">${radios}` +
    `<div class="vg-dtablist">${tablist}</div>` +
    `<div class="vg-dpanels">${panels}</div></div></div>`;
}

/**
 * note タブ 1 枚ぶん。description の段（あれば）＋ メモの段。
 *
 * メモの本体はここには入れない。**目印（NOTE_MARK）を置くだけ。** カードは
 * 日次で作り置きするが、メモはビューの中で毎回作る（シートを直した内容が
 * その場で出るようにするため）。
 *
 * 段は常に 2 つ出す。description が 1 つも無いときも上の段は出して
 * 「未設定」と書く（renderDesc を参照）。片方だけ消すと、出どころの違いを
 * 示すための見出しが、あるときと無いときで入れ替わって読みにくい。
 */
function renderNote(b, descs, mark) {
  const memo = String(mark == null ? '' : mark);
  return renderDesc(b, descs) +
    `<div class="vg-nsec"><div class="vg-nhead">メモ</div>${memo}</div>`;
}

/**
 * このファイルが出す markup に対応する CSS。
 * columns.js / sqltext.js / markdown.js と同じ考え方で、クラス名を付けている
 * 側に置く。配る 1 枚は viewlgc_group_css が chromeCss() と連結して作る。
 */
function descCss() {
  const rules = [
    // 段。2 つ並んだときに境目が読めればよいので、囲まずに間だけ空ける。
    `.vg-nsec{margin:0 0 18px}`,
    `.vg-nsec:last-child{margin-bottom:0}`,
    // 段の見出し。本文より弱く、しかし出どころの違いが分かる程度には目立たせる。
    `.vg-nhead{margin:0 0 6px;padding:0 0 4px;border-bottom:1px solid #EAEEF2;` +
      `font:11px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `font-weight:600;letter-spacing:.04em;color:#57606A}`,
    // タブ。ラジオは画面から隠すが、display:none にはしない（キーボードで
    // 辿れなくなるうえ、ブラウザによっては :checked が働かない）。
    `.vg-dr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}`,
    `.vg-dtablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 8px}`,
    `.vg-dtab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;` +
      `border:1px solid #D0D7DE;border-radius:14px;color:#57606A;` +
      `cursor:pointer;user-select:none;font-weight:600;font-size:12px;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    // hover は選択中より 1 段薄くする。**選択中と同じ色にしない。**
    // 以前は hover も #EAEEF2 で、下の選択色を無彩色にしたときに
    // 「選ばれている」と「マウスが乗っている」が見分けられなくなった。
    `.vg-dtab:hover{background:#F6F8FA;color:#24292F}`,
    `.vg-dpanel{display:none}`,
    // 1 種類しか無いときの見出し。ラジオを持たないので押しても何も起きない
    // （<span>）。見た目は選択中と同じ ― 実際「いま見ているもの」なので同じ。
    // .vg-dtab:hover と詳細度が並ぶので、あとに置いて勝たせる（乗っても光らない）。
    `.vg-dtab.vg-dstatic{${DESC_TAB_ON};cursor:default}`,
  ];
  // タブ本体。ID ではなくクラスで書くので、レコードが変わってもこの CSS のまま。
  // 形は「兄弟 > 子」から動かさない。この viz で radio + :checked が動くと
  // 確かめたときの形がこれ（templated_record/samples/07_radio_tabs_test.html）。
  for (let i = 1; i <= MAX_DESC_TABS; i++) {
    rules.push(`.vg-dr${i}:checked ~ .vg-dpanels > .vg-dp${i}{display:block}`);
    rules.push(`.vg-dr${i}:checked ~ .vg-dtablist > .vg-dt${i}{${DESC_TAB_ON}}`);
  }
  return rules.join('\n');
}

module.exports = {
  renderNote, renderDesc, descCss, descGroups, descPanel, suffixByView,
};
