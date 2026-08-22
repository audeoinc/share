'use strict';
/**
 * analyze() の結果（base 1 件分）を表示用 HTML にする。
 *
 *   全体タイトル : suffix を除いた View 名
 *   ペイン見出し : 同じロジックを持つ suffix の列記
 *   本体         : グループ間の差分（パラメータ化済み SQL 同士の比較）
 *   末尾         : 何をパラメータ化したかの一覧（判定の当否を人が確認するため）
 *
 * レイアウト: グループ数によらずタブ。タブは基準グループ ＋ 比較相手で、
 * 枚数がそのままグループ数になる。基準タブは常に選択状態で固定（左ペインに
 * 出っぱなしのため）、比較相手のタブだけが切り替わる。
 *   1 グループ  … 基準タブ 1 枚 ＋ SQL 1 ペイン（比較する相手がいないため）
 *   2 グループ〜… 基準タブ ＋ 比較相手のタブ。中身は 2 ペイン比較
 *                 （3 ペイン横並びは 1 ペインが狭くなって読めないので採らない）
 *
 * 3 ペイン横並び（renderFragment3）は使わない方針にしたので、
 * build_udf.mjs で 3-way 系の関数ごと UDF から外している（サイズ削減）。
 *
 * タブは radio + :checked の CSS のみで動く（JavaScript は使えない）。
 * CSS セレクタは ID ではなくクラスで書いてある。ID はレコードごとに
 * 一意にする必要があるため、ID を参照すると CSS を静的にできない。
 */

const { splitLines, build2Way } = require('../ddl_diff_viz/src/lib/diff');
const { renderFragment1, renderFragment2 } = require('../ddl_diff_viz/src/lib/render');

const MAX_TABS = 12; // 静的 CSS が面倒を見るタブ数の上限

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

const REASON_TEXT = {
  'length': 'トークン数が違う（構造そのものが別）',
  'kind': 'トークンの種類が違う',
  'not-substitutable':
    '置換できないトークンが違う（列名・別名・CTE 名・予約語など。' +
    '置換してよいのは FROM / JOIN の実体名と値だけ）',
  'inconsistent': '同じトークンが別の値に対応していて一貫しない',
  'not-injective': '別々のトークンが同じ値に対応していて 1 対 1 にならない',
};

/**
 * なぜ別グループになったかを出す。
 * グループが想定より細かく割れたとき、原因が「リテラル差を既定でロジック差に
 * している」なのか本物の差なのかを、画面だけで切り分けられるようにする。
 */
function missTable(groups) {
  // 比較用トークンでは伏せ字が制御文字になっている。そのまま出すと消えて
  // 見えるので、何を伏せたか分かる表記に戻す。
  const unmask = (s) => String(s == null ? '' : s)
    .split('\u0000').join('⟨suffix⟩')
    .replace(/\u0001(\d+)\u0001/g, '⟨同値リテラル $1 組目⟩');
  const rows = groups.filter((g) => g.miss).map((g) => {
    const d = g.miss.detail;
    const what = d.reason === 'length'
      ? `${d.aLen} 対 ${d.bLen}`
      : `<code class="vg-mcode">${esc(unmask(d.aText))}</code> ↔ ` +
        `<code class="vg-mcode">${esc(unmask(d.bText))}</code>` +
        `<span class="vg-mkind">${esc(kindText(d.kind))}</span>`;
    return `<tr><th class="vg-mname">${esc(label(g))}</th>` +
      `<td class="vg-mvs">vs ${esc(g.miss.vs)}</td>` +
      `<td class="vg-mreason">${esc(REASON_TEXT[d.reason] || d.reason)}<br>${what}</td></tr>`;
  }).join('');
  if (!rows) return '';
  const literal = groups.some((g) => g.miss &&
    g.miss.detail.reason === 'not-substitutable' &&
    (g.miss.detail.kind === 'string' || g.miss.detail.kind === 'number'));
  const hint = literal
    ? `<div class="vg-mhint">値の違いで割れています。` +
      `既定では値はパラメータ化して同じグループにするので、` +
      `<code class="vg-mcode">substitutable</code> を絞った設定になっています。` +
      `既定に戻すなら options_json から ` +
      `<code class="vg-mcode">"substitutable"</code> を外します。` +
      `<br>絞ったまま特定の値だけ同一視したいなら、` +
      `<code class="vg-mcode">"equivalentLiterals": ["suffix", ["apac","amer","emea"]]</code>` +
      ` のように組で並べます（<code class="vg-mcode">"suffix"</code> は` +
      `その View 自身の suffix を表す予約語）。</div>`
    : '';
  return `<details class="vg-params vg-miss"><summary class="vg-psummary">` +
    `なぜ別グループになったか</summary>${hint}` +
    `<div class="vg-pblock"><table class="vg-ptable">${rows}</table></div></details>`;
}

/** 何をパラメータ化したかの一覧。判定の当否を人が確認できるようにする。 */
function paramsTable(groups) {
  const blocks = groups.map((g) => {
    if (!g.params.length) {
      return `<div class="vg-pblock"><div class="vg-plabel">${esc(label(g))}</div>` +
        `<div class="vg-pnone">差分なし（完全一致）</div></div>`;
    }
    const rows = g.params.map((p) => {
      const vals = Object.entries(p.values)
        .map(([s, v]) => `<div class="vg-pv"><span class="vg-psuf">${esc(s)}</span>${esc(v)}</div>`)
        .join('');
      // 種別を出す。実体名の差は suffix 違いなら当然なので流し見でよく、
      // 値の差は業務上の意味があるので人が見るべき、という区別のため。
      const kind = `<span class="vg-mkind">${esc(kindText(p.kind))}</span>`;
      return `<tr><th class="vg-pname">${esc(p.name)}</th>` +
        `<td class="vg-pvals">${kind}${vals}</td></tr>`;
    }).join('');
    return `<div class="vg-pblock"><div class="vg-plabel">${esc(label(g))}</div>` +
      `<table class="vg-ptable">${rows}</table></div>`;
  }).join('');
  return `<details class="vg-params"><summary class="vg-psummary">` +
    `パラメータ化した箇所（グループ内で異なるトークン）</summary>${blocks}</details>`;
}

/**
 * SQL 中の {{P1}} に付ける tooltip の文言。{ P1: '…' } の形で返す。
 *
 * 何に置き換わるのかは末尾の一覧に出しているが、SQL を読んでいる最中に
 * そこまで目を往復させずに済むよう、その場でも見えるようにする。
 * パラメータ名はグループごとに独立して振るので、対応表もグループごとに作る。
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
 * 基準グループのタブ。左ペインに出っぱなしなので、選択状態で固定して出す。
 * ラジオを持たないので押しても切り替わらない（label ではなく span）。
 */
function baseTab(g) {
  return `<span class="vg-tab vg-tbase"><span class="vg-tbadge">基準</span>` +
    `${esc(label(g))}<span class="vg-tabn">${g.members.length}</span></span>`;
}

/**
 * タブ。先頭は基準グループで、常に選択状態のまま固定する。
 *
 * 基準を左ペインに出しているのにタブが比較相手の分しか無いと、
 * 「タブの数＝グループ数」に見えて数が合わないように読めてしまう。
 * 基準の分もタブに並べれば、タブを数えればグループ数になる。
 *
 * 1 グループのときもタブを 1 枚出す。比較相手がいないので中身は SQL 1 ペイン。
 */
function tabs(groups, opts, idPrefix) {
  const [base, ...others] = groups;
  const shown = others.slice(0, MAX_TABS);
  const radios = shown.map((g, i) =>
    `<input class="vg-r vg-r${i + 1}" type="radio" name="${idPrefix}"` +
    ` id="${idPrefix}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tablist = baseTab(base) + shown.map((g, i) =>
    `<label class="vg-tab vg-t${i + 1}" for="${idPrefix}-${i + 1}">` +
    `${esc(label(g))}<span class="vg-tabn">${g.members.length}</span></label>`).join('');
  const panels = shown.length
    ? shown.map((g, i) =>
      `<div class="vg-panel vg-p${i + 1}">${pair(base, g, opts)}</div>`).join('')
    : `<div class="vg-single">${renderFragment1(
      label(base), paneSub(base), splitLines(base.sql), opts, paramTips(base))}</div>`;

  const over = others.length > shown.length
    ? notice(`グループが多いため先頭 ${MAX_TABS} 件のみタブ表示しています` +
      `（全 ${others.length} 件）。`)
    : '';

  return over +
    `<div class="vg-tabs">${radios}` +
    `<div class="vg-tablist">${tablist}</div>` +
    `<div class="vg-panels">${panels}</div></div>`;
}

/**
 * base 1 件分の HTML を返す。
 * @param {{base:string, viewCount:number, groupCount:number, groups:object[]}} b
 */
function renderBase(b, opts) {
  const o = opts || {};
  const groups = b.groups;
  const n = groups.length;
  // id はレコード内で一意であればよいが、同じページに複数レコードが並ぶ場合に
  // 備えて、base 名だけでなくグループ構成も混ぜてハッシュする。
  // （同一内容を 2 回描画した場合は衝突しうる。1 チャート 1 レコードが前提。）
  const idPrefix = 'vgt' + hashId(b.base + '|' + groups.map(label).join('|'));

  // グループ数によらずタブで出す。タブを数えればグループ数になる形にそろえる。
  let body;
  if (n === 0) {
    body = notice('View が見つかりません。');
  } else {
    // 比較する相手がいないときは、同じ SQL を左右に並べても読む人が得るものが
    // 無いので、基準タブ 1 枚と SQL 1 ペインになる。
    const lead = n > 1 ? '' : notice(b.unmatched
      ? 'suffix を認識できなかった View です。比較相手がないので単独で表示しています。'
      : `${b.viewCount} View すべてが同一ロジックです。比較の必要がないので SQL だけ出しています。`);
    body = lead + tabs(groups, o, idPrefix);
  }

  return `<div class="vg-root">` +
    header(b.base, b.viewCount, n, b.unmatched) +
    body +
    missTable(groups) +
    paramsTable(groups) +
    `</div>`;
}

// ---------------------------------------------------------------------
// 見出し・タブ・パラメータ表の CSS。
// 差分表そのものの CSS は render.js が出す（DIFF_CSS 側）。
// ID を参照していないので、レコードが増えてもこの CSS のまま使える。
// ---------------------------------------------------------------------
function chromeCss() {
  const rules = [
    `.vg-root{font:13px/1.6 'Roboto','Segoe UI',system-ui,-apple-system,sans-serif;color:#24292F}`,
    `.vg-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 10px}`,
    `.vg-title{font:600 15px/1.6 inherit;color:#1A1A1A}`,
    `.vg-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px}`,
    `.vg-notice{margin:8px 0;padding:8px 12px;border:1px solid #D0D7DE;border-left:4px solid #57606A;` +
      `border-radius:4px;background:#F6F8FA;color:#57606A}`,
    // タブ
    `.vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}`,
    `.vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}`,
    `.vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;` +
      `border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}`,
    `.vg-tab:hover{background:#EAEEF2;color:#24292F}`,
    // 基準タブ。左ペインに出っぱなしなので選択状態で固定する（押しても切り替わらない）。
    // 色は基準ペイン（render.js の paneColors.base = #E17B7B）の薄い色に合わせてある。
    // 既定値を焼き込んでいるので、opts.colors.baseColor を変えたらここも直す。
    `.vg-tbase{background:#fbeded;border-color:#efb6b6;color:#24292F;cursor:default}`,
    `.vg-tbase:hover{background:#fbeded;color:#24292F}`,
    `.vg-tbadge{padding:0 6px;border-radius:8px;background:#f6d7d7;color:#87494a;font-size:11px;font-weight:600}`,
    `.vg-tabn{padding:0 6px;border-radius:8px;background:#EAEEF2;color:#57606A;font-size:11px}`,
    `.vg-panels{border:1px solid #D0D7DE;border-radius:0 6px 6px 6px;padding:10px;background:#fff}`,
    `.vg-panel{display:none}`,
    // パラメータ表
    `.vg-params{margin:12px 0 0;border:1px solid #D0D7DE;border-radius:6px;background:#F6F8FA}`,
    `.vg-psummary{padding:8px 12px;cursor:pointer;color:#57606A;font-weight:600;font-size:12px}`,
    `.vg-pblock{padding:0 12px 10px}`,
    `.vg-plabel{font:600 12px/1.8 inherit;color:#24292F}`,
    `.vg-pnone{color:#57606A;font-size:12px}`,
    `.vg-ptable{border-collapse:collapse;width:100%}`,
    `.vg-pname{width:44px;text-align:left;vertical-align:top;padding:3px 8px 3px 0;` +
      `color:#8250DF;font:600 12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-pvals{padding:3px 0}`,
    `.vg-pv{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#57606A;word-break:break-all}`,
    `.vg-psuf{display:inline-block;min-width:44px;color:#24292F;font-weight:600}`,
    // 「なぜ別グループになったか」。パラメータ表と同じ枠・同じ地色で出す。
    // 常時出るものを警告色にすると、見るべきときの手がかりにならない。
    `.vg-mhint{padding:0 12px 8px;color:#57606A;font-size:12px}`,
    `.vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;` +
      `font:600 12px/1.6 inherit;color:#24292F;white-space:nowrap}`,
    `.vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}`,
    `.vg-mreason{padding:3px 0;color:#57606A;font-size:12px}`,
    `.vg-mcode{padding:1px 5px;border-radius:3px;background:#FFEBE9;color:#82071E;` +
      `font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-mkind{margin-left:6px;color:#8250DF;font-size:11px}`,
  ];
  // タブ本体。ID ではなくクラスで書くので、CSS を静的に保てる。
  for (let i = 1; i <= MAX_TABS; i++) {
    rules.push(`.vg-r${i}:checked ~ .vg-panels > .vg-p${i}{display:block}`);
    rules.push(`.vg-r${i}:checked ~ .vg-tablist > .vg-t${i}` +
      `{background:#fff;border-color:#D0D7DE;color:#24292F}`);
    rules.push(`.vg-r${i}:checked ~ .vg-tablist > .vg-t${i} .vg-tabn{background:#DDF4FF;color:#0969DA}`);
  }
  return rules.join('\n');
}

module.exports = { renderBase, chromeCss, MAX_TABS, hashId, label };
