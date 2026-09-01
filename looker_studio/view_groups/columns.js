'use strict';
/**
 * View のカラム定義（INFORMATION_SCHEMA.COLUMNS）を 1 枚の表にする。
 *
 *   1 行 = 1 列名、1 列 = 1 **カラム定義グループ**。セルは型・モード・説明。
 *
 * **列の束ね方はロジック グループではない。** 同じロジック グループなら SQL は
 * α 等価だが、参照先テーブルの型が違えば出力列の型も違う（amount が jp は
 * NUMERIC、us は FLOAT64 など）。description も View ごとに付けるものなので、
 * SQL が 1 文字も違わないのに定義だけ食い違うことがある。これはロジック差分には
 * 出てこない（SQL は同一だから）。むしろこの表の一番の値打ちがそこなので、
 * **この表だけはカラム定義そのものでグループを組み直す。**
 *
 * 鍵は「列名・型・モード・説明」の集合。**並び順（ordinal）は鍵に入れない**
 * ので、同じ列が違う順で書いてあるだけの View は 1 つの列にまとまる。
 * その並び順の食い違いだけは ⚠ の内訳に出す（残った唯一の軸なので黙らせない）。
 *
 * 結果として列の本数は最大で View の本数になる。全 View の定義が違えば
 * 1 View = 1 列になるが、それは「本当に全部違う」ということなので、そう見せる。
 *
 * グループごとのタブにしなかったのは、列名も型も短くて横に並べても収まるから。
 * 全グループを一度に見せれば、どこが揃っていないかをタブを押さずに見つけられる。
 * SQL は横に長いので差分側は 2 ペインだが、こちらは事情が違う。
 *
 * 出すのは型・モード（NULLABLE / REQUIRED / REPEATED。BigQuery のコンソールと
 * 同じ表記）・説明。**並び順（ordinal）は出さない。**
 * 行がその順に並んでいるので番号を添えても読めるものが増えず、
 * 列を 1 本足すと以降がまとめてずれて目障りになるだけ。
 *
 * **この表に「基準」は無い。** 全グループを横に並べている以上、どれか 1 つを
 * 基準に立てなくても違いはそのまま読める。差分側は「基準と 1 つを見比べる」
 * 作りなので基準が要るが、こちらは要らない。揃っていないセルは、その列で
 * いちばん多い値と違うものに色を付ける。
 */

const { esc, label, notice } = require('./chrome.js');

/** 同じ列の中で並び順が食い違っていることを示す印。セルの中に置く。 */
const WARN = '⚠';

/**
 * 表の幅まわり。MAX_TABLE_W は columnsCss() の .vg-ctable の max-width と
 * 同じ値（片方だけ変えると min-width の判定がずれる）。MIN_COL_W は 1 列に
 * 要る幅の下限で、型（RECORD / REPEATED）と説明の 2 列の表が畳まれずに入る幅。
 *
 * **列名の欄だけは px で決める。** 割合にすると、列が増えて表を広げたときに
 * 列名の欄まで一緒に広がってしまい（18% は 1530px なら 275px）、名前しか
 * 入っていない欄に幅を取られる。px で止めれば、広げたぶんはすべてグループの
 * 列に回る。残りの列は幅を指定しない ― table-layout:fixed では、幅の無い列が
 * 残りを均等に分ける決まりなので、これで「列名 180px ＋ 均等割り」になる。
 */
const MAX_TABLE_W = 1000;
const MIN_COL_W = 150;
const NAME_COL_W = 180;

/**
 * 型の文字列に折り返し位置を入れる。
 *
 * ARRAY<STRUCT<currency STRING, gross NUMERIC, net NUMERIC>> のような型は
 * 空白が少なく、ブラウザから見ると 1 語に近い。CSS の overflow-wrap や
 * word-break でも折れるはずだが、**埋め込み先で効くかどうかに賭けたくない**
 * （table-layout:fixed も含め、こちらが指定した CSS がそのまま効かない場面を
 * この画面では何度か踏んでいる）。<wbr> は「ここで折ってよい」を markup 側で
 * 示す要素で、CSS の解釈に依存しない。
 *
 * 入れるのは < と , のうしろ。型の構造の切れ目なので、折れても読める。
 * 引数はエスケープ済みの文字列（< は &lt; になっている）。
 */
function breakType(escaped) {
  return String(escaped).replace(/(&lt;|,)/g, '$1<wbr>');
}

/**
 * 列の説明（INFORMATION_SCHEMA の description）の読み取り。
 *
 * 素のテキストのこともあれば、論理名を持たせるために JSON を入れてあることも
 * ある（BigQuery の description は自由文字列なので、構造を持たせたければ
 * こうするしかない）。
 *
 *   {"ja": "受注日", "en": "order date"}
 *
 * **キー名は環境によって違うので、よくある綴りをまとめて受ける。** 決め打ちに
 * すると、綴りが 1 つ違うだけで論理名が丸ごと出なくなる（しかもエラーは出ず、
 * 説明が空に見えるだけ）。拾えなかったキーも捨てずに表へ並べるので、
 * **どう書いても画面から消えることはない**。認識できたキーは並び順が
 * 前に来るだけで、扱いは変わらない。
 *
 * JSON として読めなければ、そのまま素のテキストとして扱う（従来どおり）。
 */
const DESC_JA_KEYS = ['ja', 'jp', 'ja_name', 'name_ja', 'japanese',
  'logical_name_ja', 'logicalNameJa', 'ja_logical_name',
  '和名', '日本語', '日本語論理名', '論理名'];
const DESC_EN_KEYS = ['en', 'en_name', 'name_en', 'english',
  'logical_name_en', 'logicalNameEn', 'en_logical_name',
  '英語', '英語論理名'];

/** 候補のキーのうち、最初に見つかった空でない値。 */
function pickKey(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v == null || String(v) === '') continue;
    return { key: k, value: String(v) };
  }
  return null;
}

/**
 * @returns {null | {raw: string} | {ja: string, en: string, rest: object[]}}
 */
function parseDesc(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  // '{' で始まらないものに JSON.parse を試す意味はない。素のテキストは
  // そのまま出す（この形のほうが圧倒的に多い）。
  if (s.charAt(0) !== '{') return { raw: s };
  let o = null;
  try { o = JSON.parse(s); } catch (e) { o = null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { raw: s };

  const ja = pickKey(o, DESC_JA_KEYS);
  const en = pickKey(o, DESC_EN_KEYS);
  const used = {};
  if (ja) used[ja.key] = true;
  if (en) used[en.key] = true;
  const rest = [];
  const keys = Object.keys(o);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (used[k]) continue;
    const v = o[k];
    if (v == null || v === '') continue;
    rest.push({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) });
  }
  // pairs は表に出す順。日本語 → 英語 → 残り（JSON に書いてあった順）。
  const pairs = [];
  if (ja) pairs.push(ja);
  if (en) pairs.push(en);
  for (let i = 0; i < rest.length; i++) pairs.push(rest[i]);
  return { ja: ja ? ja.value : '', en: en ? en.value : '', rest: rest, pairs: pairs };
}

/**
 * 列名の下に出す説明。
 *
 * **JSON だったものは 2 列の表にする。** `key: value` の 1 行で並べると、
 * どこまでがキーでどこからが値なのかが読み取りにくい（値の中に ':' が
 * 入っていることもある）。列で分けてしまえば迷いようがない。
 *
 * キーは **JSON に書いてあった綴りをそのまま出す。** 'ja' を '日本語' の
 * ように言い換えると、画面とシートで名前が違うことになり、突き合わせるときに
 * 一段考える手間が増える。並べる順だけ日本語 → 英語 → 残り にそろえる。
 *
 * 素のテキスト（JSON でない）はキーが無いので、これまでどおり 1 行で出す。
 */
function descHtml(text) {
  const d = parseDesc(text);
  if (!d) return '';
  if (d.raw) return `<div class="vg-cdesc">${esc(d.raw)}</div>`;
  if (!d.pairs.length) return '';
  const rows = d.pairs.map((p) =>
    `<tr><th class="vg-cdk">${esc(p.key)}</th>` +
    `<td class="vg-cdv">${esc(p.value)}</td></tr>`).join('');
  // 列幅は決め打ちにしない。**キー列はいちばん長いキーの幅**になり、残りが
  // 値に回る（この寸法合わせは CSS ではなくブラウザの表レイアウトの仕事）。
  // 割合で決めていた頃は、キーが短いと値との間が空いて対応が読み取りにくく、
  // 長いと折り返して縦に伸びた。
  //
  // 効かせ方は .vg-cdk / .vg-cdv の側。**キーは nowrap、値は width:100%。**
  // 折り返しを許すとキー列は 1 文字まで詰められる（実際にそれで一度出した）。
  return `<table class="vg-cdtable">${rows}</table>`;
}

/**
 * 型の文字列から STRUCT のフィールド名を宣言順に取り出す。
 *
 * ネストした項目の並び順を決めるのに使う。COLUMN_FIELD_PATHS には
 * ordinal_position が無い（最上位にしかない）ので、辞書順にするか、
 * 親の型の中での出現位置を見るかのどちらかになる。**表示している型の文字列と
 * 並びが一致しているほうが読みやすい**ので後者を採る。
 *
 *   ARRAY<STRUCT<currency STRING, gross NUMERIC>>  ->  ['currency', 'gross']
 *
 * 読めなければ空を返す。呼び出し側はその項目を後ろに回す（落とさない）。
 */
function structFields(type) {
  const s = String(type == null ? '' : type);
  const at = s.indexOf('STRUCT<');
  if (at < 0) return [];
  const parts = [];
  let cur = '';
  let depth = 0;
  for (let i = at + 7; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '>' && depth === 0) { parts.push(cur); break; }
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    // 'currency STRING' / 'items ARRAY<STRUCT<...>>' の先頭語がフィールド名
    const name = parts[i].trim().split(/[\s<]/)[0];
    if (name) out.push(name);
  }
  return out;
}

/**
 * 行の並び順の鍵。最上位は ordinal、ネストは親の型の中での出現位置。
 *
 * 文字列にしておくと、親が子より必ず前に来る（前方一致で短いほうが小さい）。
 * 型から読めなかった項目は 9999 にして後ろへ回す。
 */
function assignOrder(out) {
  const pad = (n) => ('000' + n).slice(-4);
  for (const e of out.values()) {
    const segs = e.name.split('.');
    const top = out.get(segs[0]);
    const ord = top && top.vals[0] && top.vals[0].ord != null ? top.vals[0].ord : 9999;
    let key = pad(ord);
    let path = segs[0];
    for (let i = 1; i < segs.length; i++) {
      const parent = out.get(path);
      const fields = parent && parent.vals[0] ? structFields(parent.vals[0].type) : [];
      const at = fields.indexOf(segs[i]);
      key += '.' + pad(at < 0 ? 9999 : at);
      path += '.' + segs[i];
    }
    e.sortKey = key;
  }
}

/**
 * 型を BigQuery のコンソールと同じ見え方に畳む。
 *
 *   ARRAY<STRUCT<currency STRING, …>>  ->  RECORD / REPEATED
 *   STRUCT<currency STRING, …>         ->  RECORD
 *   ARRAY<INT64>                       ->  INT64 / REPEATED
 *   INT64                              ->  INT64
 *
 * STRUCT の中身は子の行に出ているので、親の型に同じものを並べても場所を取る
 * だけで読めるものは増えない。スカラーの型名は標準 SQL のまま（INTEGER では
 * なく INT64）にしてある。SQL タブに出る型と揃えるため。
 */
function typeShape(type) {
  const s = String(type == null ? '' : type).trim();
  const repeated = s.slice(0, 6).toUpperCase() === 'ARRAY<';
  let inner = s;
  if (repeated) inner = s.slice(s.indexOf('<') + 1, s.lastIndexOf('>')).trim();
  const record = inner.slice(0, 7).toUpperCase() === 'STRUCT<';
  return { repeated: repeated, record: record, name: record ? 'RECORD' : inner };
}

/** ネストした項目（field_path に '.' がある）。列名に '.' は使えないので確実。 */
const isNested = (name) => String(name).indexOf('.') >= 0;

/**
 * カラム定義の指紋。同じ指紋の View を 1 つの列にまとめる。
 *
 * 入れるのは列名・型・モード（is_nullable）・説明。**並び順は入れない。**
 * 同じ列を違う順で書いてあるだけの View まで別の列にすると、表が横に伸びる割に
 * 読めるものが増えない（並び順は表に出していないので、2 つの列が字面では
 * まったく同じに見えてしまう）。並び順の食い違いは ⚠ の側で出す。
 *
 * 列名で並べ替えてから繋ぐので、並び順の違いは指紋に響かない。
 * 区切りには制御文字を使う。列名・型・説明のどれにも入りえないため。
 */
function columnSig(cols) {
  const rows = (cols || []).map((c) => [
    String(c.n == null ? '' : c.n),
    String(c.t == null ? '' : c.t),
    c.u == null || c.u === '' ? '' : String(c.u).toUpperCase(),
    String(c.d == null ? '' : c.d),
  ].join('\u0001'));
  rows.sort();
  return rows.join('\u0002');
}

/**
 * base の全 View をカラム定義で束ね直す。
 *
 * 返すのはロジック グループと同じ形（{ suffixes, members }）なので、
 * 描画側から下は何も変えずに済む（label() もそのまま効く）。
 *
 * 並びはロジック グループに合わせて「大きい順、同数なら suffix 順」。
 * 先頭が表の行の並びの土台になるので、いちばん多い定義を土台にしたい。
 */
function columnGroups(b, byView) {
  const index = new Map();
  const out = [];
  const groups = (b && b.groups) || [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const members = g.members || [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const sig = columnSig(byView[m.viewName]);
      let e = index.get(sig);
      if (!e) { e = { suffixes: [], members: [] }; index.set(sig, e); out.push(e); }
      // suffix が取れなかった View は null のまま渡す（label() が View 名で出す）。
      e.suffixes.push((g.suffixes && g.suffixes[i]) != null ? g.suffixes[i] : null);
      e.members.push(m);
    }
  }
  const key = (e) => String(e.suffixes[0] == null ? e.members[0].viewName : e.suffixes[0]);
  for (const e of out) {
    // suffix 順に並べ替える（suffixes と members は対で動かす）
    const idx = e.members.map((m, i) => i).sort((x, y) => {
      const a = String(e.suffixes[x] == null ? e.members[x].viewName : e.suffixes[x]);
      const c = String(e.suffixes[y] == null ? e.members[y].viewName : e.suffixes[y]);
      return a < c ? -1 : a > c ? 1 : 0;
    });
    e.suffixes = idx.map((i) => e.suffixes[i]);
    e.members = idx.map((i) => e.members[i]);
  }
  out.sort((a, b2) => b2.members.length - a.members.length ||
    (key(a) < key(b2) ? -1 : key(a) > key(b2) ? 1 : 0));
  return out;
}

/**
 * セルに出す説明。
 *
 * **列名の欄ではなくグループごとのセルに置く。** 説明は View に付いた属性なので、
 * グループによって違うことがある（片方だけ書いてある・文面が更新されている）。
 * 1 か所にまとめて出すとその差が消えるが、セルに置けば横に並んで見える。
 *
 * 説明は列の束ね方の鍵（columnSig）に入っているので、1 つの列の中で説明が
 * 割れることは無い。それでも割れた組を渡されたら、どの View のものかを添えて
 * 全部出す（黙って 1 つだけ出すと、鍵を緩めたときに情報が消える）。
 */
function descCell(entry) {
  if (!entry || !entry.descs.length) return '';
  if (entry.descs.length === 1) return descHtml(entry.descs[0].text);
  return entry.descs.map((d) =>
    `<div class="vg-cdescwho">${esc(d.suffixes.join(', '))}</div>` +
    descHtml(d.text)).join('');
}

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
        e = { name: c.n, descs: [], order: k, vals: [] };
        out.set(c.n, e);
      }
      // 説明は View ごとの属性。同じグループの中で割れることもあるので、
      // 1 つに畳まずに「同じ文面を持つ suffix」の組で貯める。
      if (c.d) {
        const t = String(c.d);
        let hit = null;
        for (let x = 0; x < e.descs.length; x++) {
          if (e.descs[x].text === t) hit = e.descs[x];
        }
        if (hit) hit.suffixes.push(suffix);
        else e.descs.push({ text: t, suffixes: [suffix] });
      }
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
  assignOrder(out);
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
    const rows = [...m.values()].sort((a, b) =>
      (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
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

// モードの表記は BigQuery のコンソールに合わせる（NULLABLE / REQUIRED /
// REPEATED）。REPEATED は型が ARRAY かどうかで決まるので typeShape 側。
// is_nullable が取れないときだけ UNKNOWN（コンソールには無い状態）。
const nullText = (n) => (n === null ? 'UNKNOWN' : n ? 'NULLABLE' : 'REQUIRED');

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
 *   nulls NULL 制約。型より弱い情報なので小さく添える
 *   sig   グループ同士を比べるための鍵。型・モード・説明を入れ、
 *         **並び順は入れない**（1 本足すと以降が全部ずれて、型の差が埋もれる）
 *   mixed グループの中で並び順が食い違っている（またはこの列を持たない View が
 *         いる）。型・モード・説明はグループの鍵に入っているので、ここで
 *         割れることは無い ― 割れていれば別の列になっている
 *
 * 説明を sig に入れてあるのは、**説明だけが違って列が 2 本に分かれたときに、
 * どの列が違うのかを色で示すため。** 入れないと、列は増えているのに
 * 色の付いたセルが 1 つも無い、という読み手泣かせの状態になる。
 */
function cellInfo(entry, memberCount) {
  if (!entry) return { text: null, meta: '', sig: null, mixed: false };
  const types = uniq(entry.vals.map((v) => v.type));
  const nulls = uniq(entry.vals.map((v) => nullText(v.nullable)));
  // 並び順だけが残った軸。ここは列の束ね方の鍵に入れていないので、
  // 同じ列の中で食い違いうる（唯一の ⚠ の出どころ）。
  const mixed =
    uniq(entry.vals.map((v) => String(v.ord))).length > 1 ||
    entry.vals.length !== memberCount;
  const shapes = entry.vals.map((v) => typeShape(v.type));
  const descs = entry.descs.map((d) => d.text).join('');
  return {
    // text は型そのまま。shape は Console と同じ畳み方。どちらを出すかは
    // 子の行があるかどうかで描画側が決める（中身が他に出ていないのに
    // RECORD に畳むと、定義が画面のどこからも読めなくなる）。
    text: types.join(' / '),
    shape: uniq(shapes.map((s) => s.name)).join(' / '),
    // 全部が ARRAY のときだけ REPEATED。割れていたら NULL 制約の側で出る。
    repeated: shapes.length > 0 && shapes.every((s) => s.repeated),
    record: shapes.some((s) => s.record),
    nulls: nulls.join(' / '),
    // 比べるのは畳む前の型。RECORD 同士でも中身が違えば差として出す
    // （どこが違うかは子の行に出る）。
    sig: types.join(' / ') + '|' + nulls.join(' / ') + '|' + descs,
    mixed: mixed,
  };
}

/** グループ内で並び順が食い違ったときの内訳。tooltip に出す。 */
function mixedTip(entry, g) {
  // ネストした項目は自前の並び順も NULL 制約も持たない（親のものが入っている）。
  const nested = isNested(entry.name);
  const lines = entry.vals.map((v) => nested
    ? `${v.suffix} = ${v.type}`
    : `${v.suffix} = #${v.ord} ${v.type} ${nullText(v.nullable)}`);
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
 *
 * 列（グループ）はここで組み直す ― 引数は base とカラム定義だけで足りる。
 */
function renderColumns(b, byView) {
  if (!(b.groups || []).length) return notice('View が見つかりません。');
  // 列はロジック グループではなくカラム定義で束ね直す。同じ SQL でも参照先の
  // 型や description が違えば別の列になり、逆に別ロジックでも定義が同じなら
  // 1 本にまとまる。この表で見たいのは定義の異同なので、そちらを軸にする。
  const groups = columnGroups(b, byView || {});
  const maps = groups.map((g) => groupColumns(g, byView || {}));
  const order = columnOrder(maps);
  if (!order.length) {
    return notice('カラム定義を取得できませんでした。' +
      'INFORMATION_SCHEMA.COLUMNS から列が読めているか確認してください。');
  }

  // 子の行を持つ項目。親の型を RECORD に畳んでよいかの判断に使う。
  const hasChild = new Set();
  for (const path of order) {
    const at = path.lastIndexOf('.');
    if (at > 0) hasChild.add(path.slice(0, at));
  }

  let diffRows = 0;
  let mixedCount = 0;
  const rows = order.map((name) => {
    const segs = name.split('.');
    const depth = segs.length - 1;
    const nested = depth > 0;
    const infos = groups.map((g, i) => cellInfo(maps[i].get(name), g.members.length));
    // グループ間で揃っているか。基準は立てず、いちばん多い値と違うものに色を付ける。
    const top = majority(infos.map((c) => c.sig));
    const uneven = infos.some((c) => c.sig !== top);
    if (uneven) diffRows++;
    const cells = infos.map((c, i) => {
      const g = groups[i];
      const e = maps[i].get(name);
      const cls = ['vg-ccell'];
      if (!c.text) cls.push('vg-cnone');
      // 多数派と違う型・NULL 制約。並び順の違いは色にしない（上の説明のとおり）。
      else if (c.sig !== top) cls.push('vg-cdiff');
      if (c.mixed) { cls.push('vg-cmix'); mixedCount++; }
      // 畳んでよいのは、畳んでも定義が読めなくならないとき。
      //   ARRAY<STRING> -> STRING / REPEATED   … 中身が無いので常に畳める
      //   ARRAY<STRUCT<…>> -> RECORD / REPEATED … 子の行に中身が出ているときだけ
      // include_nested_fields = FALSE のときに RECORD へ畳むと、STRUCT の定義が
      // 画面のどこからも読めなくなる。
      const shown = (!c.record || hasChild.has(name)) ? c.shape : c.text;
      // ネストした項目には並び順も NULL 制約も無い（COLUMN_FIELD_PATHS が
      // 持っていない）。親のものを出すと嘘になるので出さない。REPEATED は
      // その項目自身の型から分かるので出す。
      // モードだけ。並び順（ordinal）は出さない — 行がその順に並んでいるので
      // 番号を添えても読めるものが増えず、列を 1 本足すと以降がまとめてずれる。
      // グループ内で食い違ったときだけ ⚠ の内訳に出す。
      const meta = nested
        ? (c.repeated ? 'REPEATED' : '')
        : (c.repeated ? 'REPEATED' : c.nulls);
      // モードは型の右に置く（行の高さを 1 行ぶん節約する）。inline なので、
      // 型が長くて折り返したときはその末尾に続く。
      const body = c.text
        ? breakType(esc(shown)) + (c.mixed
          ? `<span class="vg-cwarn" data-tip="${esc(mixedTip(e, g))}">${WARN}</span>` : '') +
          (meta ? `<span class="vg-cmeta">${esc(meta)}</span>` : '') + descCell(e)
        : '—';
      return `<td class="${cls.join(' ')}">${body}</td>`;
    }).join('');
    // ネストは葉の名前だけを字下げして出す。親の行がすぐ上にあるので、
    // 全体のパスを繰り返さなくても対応は追える。
    const cls = 'vg-cname' + (depth ? ` vg-cd${Math.min(depth, 3)}` : '');
    const shown = depth
      ? `<span class="vg-cnestmark">\u2514</span>${esc(segs[segs.length - 1])}`
      : esc(name);
    return `<tr><th class="${cls}">${shown}</th>${cells}</tr>`;
  }).join('');

  const head = groups.map((g) =>
    `<th class="vg-chead">${esc(label(g))}` +
    `<span class="vg-tabn">${g.members.length}</span></th>`).join('');

  // 何を見ればよいかを先に出す。表だけ置かれても、どこが問題かは読み取りにくい。
  // 列がロジック グループではないことは、言っておかないと必ず誤読される
  // （ロジック差分のタブと列の本数が合わないため）。
  const lead = [];
  if (groups.length === 1) {
    lead.push(notice(`${b.viewCount || groups[0].members.length} 本の View すべてで` +
      `カラム定義（列名・型・モード・説明）が一致しています。`));
  } else {
    lead.push(notice(`カラム定義が ${groups.length} 種類あります（列がその本数）。` +
      `列はロジック グループではなくカラム定義で束ねているので、` +
      `SQL が同一でも参照先テーブルの型や description が違えば別の列になります` +
      `（ロジック差分のタブには出てこない差です）。`));
    if (diffRows) {
      lead.push(notice(`型・モード・説明のいずれかが揃っていない列が ${diffRows} 件` +
        `あります（色付きのセル。その列でいちばん多い内容と違うもの）。`));
    }
  }
  if (mixedCount) {
    lead.push(notice(`同じ列の中で並び順（ordinal）だけが食い違っている箇所が` +
      `${mixedCount} 件あります（${WARN} の印。ホバーすると suffix ごとの内訳が出ます）。` +
      `並び順は列の束ね方にも表の中身にも使っていないので、ここにだけ出ます。`));
  }

  // 列名の欄は px で決め打ち、グループの列は幅を指定せず残りを均等に分ける
  // （table-layout:fixed の決まり）。型は ARRAY<STRUCT<…>> のように長くなる
  // ことがあるので、セルの中で折り返す。fixed にしないと、長い型がある列だけが
  // 伸びる。
  const colgroup = `<colgroup><col style="width:${NAME_COL_W}px">` +
    groups.map(() => `<col>`).join('') + `</colgroup>`;

  // 列はカラム定義ごとなので、最悪 View の本数まで増える（全 View の定義が
  // 違うとき）。均等割りのままだと 1 列が数十 px になって型も説明も読めない。
  // **下限を割るときだけ表に min-width を置く。** min-width は max-width より
  // 強いので、CSS 側の 1000px を押しのけて広がる。はみ出したぶんは .vg-outer
  // （カード全体のスクロール箱）が横に流してくれるし、列名行の sticky も
  // .vg-outer が基準なので効いたまま。ここに overflow を置くと、そこが新しい
  // スクロール箱になって sticky が壊れる。
  const need = NAME_COL_W + MIN_COL_W * groups.length;
  const wide = need > MAX_TABLE_W ? ` style="min-width:${need}px"` : '';

  return lead.join('') +
    `<div class="vg-ctablewrap"><table class="vg-ctable"${wide}>${colgroup}` +
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
    // 幅はカードいっぱいに取り、グループ数で均等割りする（列幅は colgroup で
    // 指定する）。横スクロールさせないので、包む div に overflow は置かない。
    // 置くとそこが縦のスクロール要素にもなり、下の sticky が効かなくなる。
    `.vg-ctablewrap{width:100%}`,
    // ★ 表の最大幅。チャートが横に広いとセルが間延びして読みづらいので頭を打つ。
    //   広げたいときはこの 1000px を変える。
    //
    // 文字の大きさは 3 段。**いちばん見たいのは型**なので、そこだけ地の大きさで
    // 出し、ほかは 1 段ずつ落とす。同じ大きさで並べると、どれを先に読めばよいかが
    // 字面から分からなくなる。
    //   12px  型（セルの本体）/ 列名 … 行の主役の 2 つ。同じ大きさで並べる
    //   11px  グループ見出し / 説明の値
    //   10px  説明の表のキー / 内訳の見出し
    //    8px  モード（NULLABLE / REQUIRED / REPEATED）
    // 1px 差は並べても読み取れないので、いちばん弱いモードは 2 段落としてある。
    `.vg-ctable{border-collapse:collapse;font-size:12px;` +
      `width:100%;max-width:${MAX_TABLE_W}px;table-layout:fixed}`,
    // 列名の行はスクロールしても残す。基準になるのはカードのスクロール箱
    // （.vg-outer）なので、その中で固定されている帯のぶんだけ下げる。ズレると
    // 帯と見出し行の間に本文がちらつくので、preview.mjs で実際に描いて
    // 位置が合っているかを見ている。
    `.vg-chead{position:sticky;top:var(--vg-bar);z-index:1;padding:6px 12px;` +
      `border:1px solid #D0D7DE;background:#F6F8FA;color:#24292F;` +
      `font-weight:600;font-size:11px;text-align:left;overflow-wrap:anywhere}`,
    // 列名は型と同じ大きさ。どちらも行の主役で、片方を落とすと読む順が
    // かえって分かりにくい（型を探すときも列名を探すときもある）。
    //
    // **横にも貼り付ける。** 列がカラム定義ごとになったので本数が増え、表が
    // カードより広くなることがある（min-width）。そのとき横へスクロールすると、
    // 列名が流れていってどの行を見ているのか分からなくなる。上の帯と同じ理屈。
    //   基準は .vg-outer（唯一のスクロール箱）。
    //   border-collapse:collapse の表では、貼り付いたセルの border は隣のセルが
    //   描くぶんが一緒に流れてしまう。右の境目だけ box-shadow で自前に描く。
    //   地色を必ず塗る（透けると下を通る本文が重なって読めなくなる）。
    `.vg-cname{position:sticky;left:0;z-index:1;background:#fff;` +
      `padding:5px 12px;border:1px solid #D0D7DE;text-align:left;` +
      `box-shadow:1px 0 0 #D0D7DE;` +
      `vertical-align:top;font-weight:600;font-size:12px;color:#24292F;` +
      `overflow-wrap:anywhere;word-break:break-all;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    // 左上の角。縦にも横にも貼り付くので、どちらのセルより手前に出す。
    `.vg-cnamehead{left:0;z-index:2;box-shadow:1px 0 0 #D0D7DE}`,
    // 列の説明。description が JSON なら日本語論理名を主、英語論理名と
    // 残りのキーを従（薄い色）で下に並べる。素のテキストなら 1 行だけ。
    `.vg-cdesc{margin:2px 0 0;font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `font-weight:400;color:#57606A}`,
    // description が JSON だったときの 2 列の表。キーと値を縦線で分ける。
    // 'key: value' の 1 行だと、値に ':' が入っていると切れ目が読めない。
    // table-layout は auto。キーの長さはまちまちで、値のほうを広く取りたい。
    `.vg-cdtable{margin:3px 0 0;border-collapse:collapse;width:100%}`,
    // キーは太字にしない。グループ見出し（.vg-chead）と同じ太さになって、
    // 見出しなのか中身なのかが字面で見分けられなくなる。小ささと色で十分弱い。
    //
    // **キーは折り返さない（nowrap）。** 値に width:100% があるので、
    // ブラウザはキー列を「最小幅」まで詰めようとする。折り返しを許すと
    // その最小幅が 1 文字になり、キーが縦に伸びる。overflow-wrap:break-word
    // でも同じで（Chromium の表レイアウトは 13px まで詰めた）、折り返しを
    // 禁じるしかない。禁じればキー列はいちばん長いキーの幅で止まる。
    //
    // 引き換えに、セルより長いキーははみ出す。10px でいちばん細いセル
    // （6 グループで 133px）に入るのは 25 文字ほどなので、実際の綴り
    // （ja / name_ja / 日本語論理名）では当たらない。
    `.vg-cdk{padding:1px 6px 1px 0;border-right:1px solid #EAEEF2;text-align:left;` +
      `vertical-align:top;white-space:nowrap;` +
      `font:10px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `color:#8C959F}`,
    // 値に width:100% を置くと、残りの幅を全部こちらが取る（= キー列は
    // いちばん長いキーの幅で止まる）。
    `.vg-cdv{padding:1px 0 1px 6px;vertical-align:top;width:100%;` +
      `font:11px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `font-weight:400;color:#57606A;overflow-wrap:anywhere}`,
    // グループの中で説明が割れているときに、どの View のものかを示す見出し。
    `.vg-cdescwho{margin:4px 0 0;font:10px/1.5 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `font-weight:600;color:#8C959F}`,
    // STRUCT の中の項目。深さぶん字下げして、親との関係を字面で見せる。
    // 3 段より深いものは 3 段目に揃える（それ以上は横幅が持たない）。
    `.vg-cd1{padding-left:26px}`,
    `.vg-cd2{padding-left:40px}`,
    `.vg-cd3{padding-left:54px}`,
    `.vg-cnestmark{margin-right:4px;color:#8C959F;font-weight:400}`,
    // 型は長くなりうる。折り返して縦に伸ばす（横スクロールを避けるため）。
    // markup 側にも <wbr> で折り返し位置を入れてあるので、ここが効かなくても
    // 型の構造の切れ目では折れる。
    `.vg-ccell{padding:5px 12px;border:1px solid #D0D7DE;vertical-align:top;` +
      `color:#24292F;overflow-wrap:anywhere;word-break:break-all;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    // モード。型より弱い情報なので、いちばん小さくして型の右に添える。
    // 1px 差だと並べても違いが読み取れないので、ここだけ 2 段落とす。
    // inline にしてあるのは行の高さを 1 行ぶん節約するため。
    `.vg-cmeta{margin-left:6px;font:8px/1.6 'Roboto','Segoe UI',system-ui,sans-serif;` +
      `letter-spacing:.04em;color:#8C959F;white-space:nowrap}`,
    // 多数派と違う型・モード・説明。差分の「追加」側と同じ地色で、目が同じ
    // 意味に慣れるようにする。
    `.vg-cdiff{background:#dfe7d2}`,
    `.vg-cnone{color:#8C959F;background:#FAFAFA}`,
    // 同じ列（= 同じカラム定義）の中で並び順だけが食い違っている箇所。
    // 型・モード・説明が違えば別の列になるので、ここに出るのは並び順だけ。
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
  renderColumns, renderColumnsBase, columnsCss, breakType, descCell,
  structFields, assignOrder, isNested, typeShape,
  columnSig, columnGroups,
  groupColumns, columnOrder, cellInfo, mixedTip, nullText, majority,
  parseDesc, descHtml, DESC_JA_KEYS, DESC_EN_KEYS,
};
