'use strict';
/**
 * note タブの中身。**ラベル ＋ description の箱 ＋ メモの箱。**
 *
 *     domain sales   tier gold          ← 全 View で同じときはチップだけ
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
 * **ラベル（View に付いた labels）はいちばん上。重さを内容に合わせる。**
 * ラベルは View ごとの属性だが、実際にはほぼ base の中で揃う。揃っている
 * ときに見出し・罫線・タブを付けると、1 行の情報に段 1 つを使うことになって
 * 場所の無駄になるので、**チップを 1 列置くだけ**にして note の主題
 * （description とメモ）を邪魔しない。
 *
 * 逆に**割れているときは段に昇格させる。** 同じロジックの View なのに
 * 8 本が sales で 1 本だけ finance、という状態はこのカードが拾いたい差
 * そのもので、黙って畳んだら消えてしまう。割れた数だけタブにして、
 * どの suffix がどの値を持っているかまで出す。
 *
 * 1 つも付いていない base では**何も出さない。** description と違って
 * labels は付いていない View のほうが普通なので、「未設定」と書くと
 * ラベルを使っていない base 全部にその 1 行が並ぶ。
 *
 * クラスの頭は description が .vg-d*、ラベルが .vg-lb*。外側（.vg-o*）・
 * 基準（.vg-b*）・比較（.vg-r/t/p）・SQL（.vg-s*）・ERD の凡例（.vg-lg*）の
 * どれとも重ならないようにしてある。重なると一方のラジオがもう一方の
 * :checked ~ に引っかかり、片方を押すともう片方も切り替わる。
 * 見た目の規則（丸いタブ・パネルを隠す）だけは両者で共有している ―
 * :checked の規則さえ別なら、塗りを分ける理由が無いため。
 */

const { esc, hashId, notice, MAX_DESC_TABS, MAX_LABEL_TABS } = require('./chrome.js');

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

/** 文字列の並び順。sort の既定はコードポイント順なので、比較を 1 か所に置く。 */
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * 「View 名の並び ＋ 何か」の組を、タブに出せる形へ直す共通部分。
 * description（h）もラベル（l）も SQL 側で同じ形に畳んで渡してくるので、
 * 見出しの作り方と並べ方はここにまとめてある。
 *
 * 並びは「中身のあるものが先 → View 数の多い順 → 見出し順」。先頭がそのまま
 * 既定で開くタブになるので、いちばん多くの View が持っているものを出したい。
 * 中身の無い組（empty）は最後に回す。
 *
 * @param {function} fill 組 1 件に中身を詰める。empty を必ず立てること
 */
function tabGroups(b, list, fill) {
  const suf = suffixByView(b);
  const src = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const d = src[i] || {};
    const names = Array.isArray(d.v) ? d.v : (d.v == null || d.v === '' ? [] : [d.v]);
    const g = {
      label: names.map((n) => suf[n] || n).sort(cmp).join(', ') || '(View なし)',
      count: names.length,
    };
    fill(g, d);
    out.push(g);
  }
  out.sort((x, y) =>
    (x.empty === y.empty ? 0 : x.empty ? 1 : -1) ||
    y.count - x.count || cmp(x.label, y.label));
  return out;
}

/**
 * description の組。受け取るのは [{ v: [View 名...], h: '<html>' }]。
 * **Markdown を HTML にするのは SQL 側（viewlgc_markdown）。** JS UDF から
 * 別の UDF は呼べないので、ここへは変換済みのものが来る。同じ文面の View は
 * SQL の GROUP BY で 1 組に畳まれている。
 */
function descGroups(b, descs) {
  return tabGroups(b, descs, (g, d) => {
    g.html = String(d.h == null ? '' : d.h);
    g.empty = g.html.trim() === '';
  });
}

/**
 * ラベルの組。受け取るのは [{ v: [View 名...], l: [{k, v}...] }]。
 * 同じラベルを持つ View は SQL の GROUP BY で 1 組に畳まれている。
 *
 * **キー名のアルファベット順に並べ直す。** SQL 側でも並べてあるが、並びが
 * 実行のたびに変わると、値が同じでも別の組に見えたり、昨日と違うものが
 * 出たように読めたりする。順序を決めるのは安いので両方でやる。
 */
function labelGroups(b, labels) {
  return tabGroups(b, labels, (g, d) => {
    const src = Array.isArray(d.l) ? d.l : [];
    const pairs = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i] || {};
      const k = String(p.k == null ? '' : p.k);
      // キーの無い組は出しようがない（値だけのラベルは BigQuery に無い）。
      if (k === '') continue;
      pairs.push({ k: k, v: String(p.v == null ? '' : p.v) });
    }
    pairs.sort((x, y) => cmp(x.k, y.k));
    g.pairs = pairs;
    g.empty = pairs.length === 0;
  });
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
 * ラベル 1 組ぶん。**キーと値を割った 2 色のチップ**にする。
 *
 * `domain: sales` と 1 本のテキストで書くと、どこまでがキーでどこからが値か
 * は区切り記号だけが頼りになる。値のほうにも `-` や `_` が入る（BigQuery の
 * ラベルで使える文字）ので、記号で読み分けるのは当てにならない。
 * 枠を割って地の色を変えれば、区切りは見た目で決まる。
 *
 * 形も description のタブ（角丸 14px の丸い錠剤）とわざと変えてある。
 * 出どころは同じでも役割が違う ― こちらは選ぶものではなく、値そのもの。
 */
function labelChips(g) {
  if (g.empty) return notice('ラベルが設定されていません。');
  return `<div class="vg-lbchips">` + g.pairs.map((p) =>
    `<span class="vg-lbchip"><span class="vg-lbk">${esc(p.k)}</span>` +
    `<span class="vg-lbv">${esc(p.v || '(空)')}</span></span>`).join('') + `</div>`;
}

/** base の中でラベルが割れているか。ヘッダーのバッジもこれで決める。 */
function labelsSplit(b, labels) {
  return labelGroups(b, labels).length > 1;
}

/**
 * ラベルの段。**内容の量に合わせて重さを変える。**
 *
 *   1 つも付いていない  → 何も出さない
 *   全 View で同じ      → チップを 1 列。見出しも罫線も付けない
 *   割れている          → 見出し ＋ 注意書き ＋ タブ（description と同じ形）
 *
 * 揃っているのが普通なので、そこに段 1 つ（見出し・罫線・余白）を使うと
 * note を開くたびに主題（description とメモ）が下へ押し下げられる。
 * 一方で割れているのは滅多に起きず、起きたときは**それ自体が拾いたい差**
 * なので、そのときだけ場所を取ってよい。
 *
 * 何も出さない判断をするのはここだけ。呼び出し側は結果を繋ぐだけにしてある。
 */
function renderLabels(b, labels) {
  const gs = labelGroups(b, labels);
  // 1 つも付いていない base では黙って引っ込む。description と違い、
  // labels は付いていないほうが普通なので、「未設定」と書くと使っていない
  // base 全部にその 1 行が並ぶ。取り込みに失敗しても同じ見え方になるが、
  // ラベルは付いていないことが正常でありうるので区別しようがない。
  if (!gs.length || gs[0].empty) return '';

  // 全 View で同じ（大半）。チップだけ置いて、note の主題を邪魔しない。
  if (gs.length === 1) return labelChips(gs[0]);

  // 割れている。ここからは description の段と同じ作り。
  const shown = gs.slice(0, MAX_LABEL_TABS);
  // 種は base だけにしない（同じ base のカードが 2 枚並ぶと name が衝突して
  // どちらのパネルも出なくなる）。description 側と同じ理由だが、**こちらは
  // 値まで種に入れる。** 見出し（suffix の組み分け）だけだと足りない ―
  // 「us だけ値が違う」カードと「us だけ付いていない」カードは組み分けが
  // 同じなので同じ種になり、並べると片方を押してもう片方が消える。
  // 実際にプレビューでその形になった。
  const id = 'vgl' + hashId(((b && b.base) || '') + '|' + gs.map((g) =>
    g.label + '=' + g.pairs.map((p) => p.k + ':' + p.v).join(',')).join('|'));
  const radios = shown.map((_, i) =>
    `<input class="vg-lbr vg-lbr${i + 1}" type="radio" name="${id}"` +
    ` id="${id}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tablist = shown.map((g, i) =>
    `<label class="vg-lbtab vg-lbt${i + 1}" for="${id}-${i + 1}">` +
    `${tabText(g)}</label>`).join('');
  const panels = shown.map((g, i) =>
    `<div class="vg-lbpanel vg-lbp${i + 1}">${labelChips(g)}</div>`).join('');
  const over = gs.length > shown.length
    ? notice(`ラベルの種類が多いため先頭 ${MAX_LABEL_TABS} 種類のみ出しています` +
      `（全 ${gs.length} 種類）。`)
    : '';

  return `<div class="vg-nsec"><div class="vg-nhead">ラベル</div>` +
    notice('同じ base の中でラベルが割れています。') + over +
    `<div class="vg-lbtabs">${radios}` +
    `<div class="vg-lbtablist">${tablist}</div>` +
    `<div class="vg-lbpanels">${panels}</div></div></div>`;
}

/**
 * note タブ 1 枚ぶん。ラベル（あれば）＋ description の段（あれば）＋ メモの段。
 *
 * メモの本体はここには入れない。**目印（NOTE_MARK）を置くだけ。** カードは
 * 日次で作り置きするが、メモはビューの中で毎回作る（シートを直した内容が
 * その場で出るようにするため）。
 *
 * description とメモの段は常に出す。description が 1 つも無いときも上の段は
 * 出して「未設定」と書く（renderDesc を参照）。片方だけ消すと、出どころの
 * 違いを示すための見出しが、あるときと無いときで入れ替わって読みにくい。
 * ラベルだけは付いていないほうが普通なので、そのときは出さない
 * （renderLabels を参照）。
 */
function renderNote(b, descs, mark, labels) {
  const memo = String(mark == null ? '' : mark);
  return renderLabels(b, labels) + renderDesc(b, descs) +
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
    //
    // 見た目の規則は description（.vg-d*）とラベル（.vg-lb*）で共有する。
    // 分けなければならないのはラジオの名前空間だけ ― :checked ~ の規則さえ
    // 別なら、丸の形や塗りまで二重に書く理由が無い。
    `.vg-dr,.vg-lbr{position:absolute;opacity:0;width:1px;height:1px;` +
      `pointer-events:none}`,
    `.vg-dtablist,.vg-lbtablist{display:flex;flex-wrap:wrap;align-items:center;` +
      `gap:6px;margin:0 0 8px}`,
    `.vg-dtab,.vg-lbtab{display:inline-flex;align-items:center;gap:6px;` +
      `padding:4px 12px;` +
      `border:1px solid #D0D7DE;border-radius:14px;color:#57606A;` +
      `cursor:pointer;user-select:none;font-weight:600;font-size:12px;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    // hover は選択中より 1 段薄くする。**選択中と同じ色にしない。**
    // 以前は hover も #EAEEF2 で、下の選択色を無彩色にしたときに
    // 「選ばれている」と「マウスが乗っている」が見分けられなくなった。
    `.vg-dtab:hover,.vg-lbtab:hover{background:#F6F8FA;color:#24292F}`,
    `.vg-dpanel,.vg-lbpanel{display:none}`,
    // 1 種類しか無いときの見出し。ラジオを持たないので押しても何も起きない
    // （<span>）。見た目は選択中と同じ ― 実際「いま見ているもの」なので同じ。
    // .vg-dtab:hover と詳細度が並ぶので、あとに置いて勝たせる（乗っても光らない）。
    `.vg-dtab.vg-dstatic{${DESC_TAB_ON};cursor:default}`,
    // ラベルのチップ。**キーと値を枠の中で割る。** 1 本のテキストにすると
    // 区切り記号だけが手掛かりになるが、値のほうにも `-` や `_` が入りうる
    // （BigQuery のラベルで使える文字）ので、記号では読み分けられない。
    `.vg-lbchips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}`,
    `.vg-lbchip{display:inline-flex;align-items:stretch;` +
      `border:1px solid #D0D7DE;border-radius:4px;overflow:hidden;` +
      `font:11px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-lbk{padding:1px 7px;background:#F6F8FA;color:#57606A;font-weight:600;` +
      `border-right:1px solid #D0D7DE}`,
    `.vg-lbv{padding:1px 8px;color:#24292F}`,
    // 割れているときはタブの中に入る。段の余白は .vg-nsec が持っているので、
    // チップ自身の下余白は要らない。
    `.vg-lbpanels .vg-lbchips{margin-bottom:0}`,
  ];
  // タブ本体。ID ではなくクラスで書くので、レコードが変わってもこの CSS のまま。
  // 形は「兄弟 > 子」から動かさない。この viz で radio + :checked が動くと
  // 確かめたときの形がこれ（templated_record/samples/07_radio_tabs_test.html）。
  for (let i = 1; i <= MAX_DESC_TABS; i++) {
    rules.push(`.vg-dr${i}:checked ~ .vg-dpanels > .vg-dp${i}{display:block}`);
    rules.push(`.vg-dr${i}:checked ~ .vg-dtablist > .vg-dt${i}{${DESC_TAB_ON}}`);
  }
  for (let i = 1; i <= MAX_LABEL_TABS; i++) {
    rules.push(`.vg-lbr${i}:checked ~ .vg-lbpanels > .vg-lbp${i}{display:block}`);
    rules.push(`.vg-lbr${i}:checked ~ .vg-lbtablist > .vg-lbt${i}{${DESC_TAB_ON}}`);
  }
  return rules.join('\n');
}

module.exports = {
  renderNote, renderDesc, descCss, descGroups, descPanel, suffixByView,
  renderLabels, labelGroups, labelChips, labelsSplit, tabGroups,
};
