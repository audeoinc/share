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
 * ようにする。**全 View で同じならタブは出さない**（1 枚しかないタブは、
 * 押せるのに何も起きない飾りにしかならない）。
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

/** 1 組ぶんの中身。未設定の組は、空白ではなくそう書く（故障と見分けが付く）。 */
function descPanel(g) {
  return g.empty
    ? notice('この View には description が設定されていません。')
    : g.html;
}

/**
 * description の段。**中身がひとつも無ければ空文字を返す**（段ごと出さない）。
 * description を付けていない base のほうが多いので、そこに空の箱が
 * 毎回出ると、note タブが「無いもの」の説明で埋まる。
 */
function renderDesc(b, descs) {
  const gs = descGroups(b, descs);
  if (!gs.some((g) => !g.empty)) return '';

  const head = `<div class="vg-nhead">View の description</div>`;
  // 1 種類しか無いならタブは出さない。押せるのに何も起きないタブになる。
  if (gs.length === 1) {
    return `<div class="vg-nsec">${head}` +
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
    `<label class="vg-dtab vg-dt${i + 1}" for="${id}-${i + 1}">${esc(g.label)}` +
    `<span class="vg-tabn">${g.count}</span></label>`).join('');
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
 * description が無いときは、メモを段で包まずそのまま返す。段の見出しは
 * 「2 つあるうちのどちらか」を示すためのもので、1 つしか無いなら邪魔になる。
 */
function renderNote(b, descs, mark) {
  const d = renderDesc(b, descs);
  const memo = String(mark == null ? '' : mark);
  if (!d) return memo;
  return d + `<div class="vg-nsec"><div class="vg-nhead">メモ</div>${memo}</div>`;
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
    `.vg-dtab:hover{background:#EAEEF2;color:#24292F}`,
    `.vg-dpanel{display:none}`,
  ];
  // タブ本体。ID ではなくクラスで書くので、レコードが変わってもこの CSS のまま。
  // 形は「兄弟 > 子」から動かさない。この viz で radio + :checked が動くと
  // 確かめたときの形がこれ（templated_record/samples/07_radio_tabs_test.html）。
  // 選択中は緑系にして、外側（黒）・基準（薄い赤）・SQL（青）と見分けられる
  // ようにする。
  for (let i = 1; i <= MAX_DESC_TABS; i++) {
    rules.push(`.vg-dr${i}:checked ~ .vg-dpanels > .vg-dp${i}{display:block}`);
    rules.push(`.vg-dr${i}:checked ~ .vg-dtablist > .vg-dt${i}` +
      `{background:#DAFBE1;border-color:#4AC26B;color:#1A7F37}`);
  }
  return rules.join('\n');
}

module.exports = {
  renderNote, renderDesc, descCss, descGroups, descPanel, suffixByView,
};
