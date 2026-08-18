'use strict';
/**
 * analyze() の結果（base 1 件分）を表示用 HTML にする。
 *
 *   全体タイトル : suffix を除いた View 名
 *   ペイン見出し : 同じロジックを持つ suffix の列記
 *   本体         : グループ間の差分（パラメータ化済み SQL 同士の比較）
 *   末尾         : 何をパラメータ化したかの一覧（判定の当否を人が確認するため）
 *
 * レイアウト:
 *   1 グループ  … 差分なしの案内
 *   2 グループ  … 2 ペイン（比較が 1 通りしかないので、タブ 1 枚は無駄）
 *   3 グループ〜… 最大グループを基準に、比較相手をタブで切り替える
 *                 （横に並べると 1 ペインが狭くなって読めないため）
 *
 * 3 ペイン横並び（renderFragment3）は使わない方針にしたので、
 * build_udf.mjs で 3-way 系の関数ごと UDF から外している（サイズ削減）。
 *
 * タブは radio + :checked の CSS のみで動く（JavaScript は使えない）。
 * CSS セレクタは ID ではなくクラスで書いてある。ID はレコードごとに
 * 一意にする必要があるため、ID を参照すると CSS を静的にできない。
 */

const { splitLines, build2Way } = require('../ddl_diff_viz/src/lib/diff');
const { renderFragment2 } = require('../ddl_diff_viz/src/lib/render');

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

const REASON_TEXT = {
  'length': 'トークン数が違う（構造そのものが別）',
  'kind': 'トークンの種類が違う',
  'not-substitutable': '置換対象外のトークンが違う（既定ではリテラルもここに入る）',
  'inconsistent': '同じトークンが別の値に対応していて一貫しない',
  'not-injective': '別々のトークンが同じ値に対応していて 1 対 1 にならない',
};

/**
 * なぜ別グループになったかを出す。
 * グループが想定より細かく割れたとき、原因が「リテラル差を既定でロジック差に
 * している」なのか本物の差なのかを、画面だけで切り分けられるようにする。
 */
function missTable(groups) {
  // 比較用トークンでは suffix が伏せ字（U+0000）になっている。そのまま出すと
  // 消えて見えるので、伏せた場所が分かる表記に戻す。
  const unmask = (s) => String(s == null ? '' : s).split('\u0000').join('⟨suffix⟩');
  const rows = groups.filter((g) => g.miss).map((g) => {
    const d = g.miss.detail;
    const what = d.reason === 'length'
      ? `${d.aLen} 対 ${d.bLen}`
      : `<code class="vg-mcode">${esc(unmask(d.aText))}</code> ↔ ` +
        `<code class="vg-mcode">${esc(unmask(d.bText))}</code>` +
        `<span class="vg-mkind">${esc(d.kind)}</span>`;
    return `<tr><th class="vg-mname">${esc(label(g))}</th>` +
      `<td class="vg-mvs">vs ${esc(g.miss.vs)}</td>` +
      `<td class="vg-mreason">${esc(REASON_TEXT[d.reason] || d.reason)}<br>${what}</td></tr>`;
  }).join('');
  if (!rows) return '';
  const literal = groups.some((g) => g.miss &&
    g.miss.detail.reason === 'not-substitutable' &&
    (g.miss.detail.kind === 'string' || g.miss.detail.kind === 'number'));
  const hint = literal
    ? `<div class="vg-mhint">リテラルの違いで割れています。` +
      `suffix と連動する値（<code class="vg-mcode">'JP'</code> / ` +
      `<code class="vg-mcode">'US'</code> など）は既定で吸収するので、` +
      `ここに残っているのは連動していない値です。それでも同一視したいなら、` +
      `options_json に ` +
      `<code class="vg-mcode">"substitutable": ["ident","quoted","number","string"]</code>` +
      ` を指定すると<b>すべての</b>リテラル差が無視されます` +
      `（<code class="vg-mcode">'A'</code> と <code class="vg-mcode">'B'</code> の差も消えます）。</div>`
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
      return `<tr><th class="vg-pname">${esc(p.name)}</th><td class="vg-pvals">${vals}</td></tr>`;
    }).join('');
    return `<div class="vg-pblock"><div class="vg-plabel">${esc(label(g))}</div>` +
      `<table class="vg-ptable">${rows}</table></div>`;
  }).join('');
  return `<details class="vg-params"><summary class="vg-psummary">` +
    `パラメータ化した箇所（グループ内で異なるトークン）</summary>${blocks}</details>`;
}

/** 基準グループと 1 グループの 2 ペイン比較。 */
function pair(baseGroup, other, opts) {
  return relabelPanes(
    renderFragment2(
      label(baseGroup), label(other),
      build2Way(splitLines(baseGroup.sql), splitLines(other.sql)),
      opts
    ),
    [`基準 / ${paneSub(baseGroup)}`, paneSub(other)]
  );
}

/** 4 グループ以上。基準は固定で、比較相手をタブで切り替える。 */
function tabs(groups, opts, idPrefix) {
  const [base, ...others] = groups;
  const shown = others.slice(0, MAX_TABS);
  const radios = shown.map((g, i) =>
    `<input class="vg-r vg-r${i + 1}" type="radio" name="${idPrefix}"` +
    ` id="${idPrefix}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tablist = shown.map((g, i) =>
    `<label class="vg-tab vg-t${i + 1}" for="${idPrefix}-${i + 1}">` +
    `${esc(label(g))}<span class="vg-tabn">${g.members.length}</span></label>`).join('');
  const panels = shown.map((g, i) =>
    `<div class="vg-panel vg-p${i + 1}">${pair(base, g, opts)}</div>`).join('');

  const over = others.length > shown.length
    ? notice(`グループが多いため先頭 ${MAX_TABS} 件のみタブ表示しています` +
      `（全 ${others.length} 件）。`)
    : '';

  return over +
    `<div class="vg-basenote">基準: <b>${esc(label(base))}</b>` +
    `（${base.members.length} View / 最大グループ）</div>` +
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

  let body;
  if (n === 0) {
    body = notice('View が見つかりません。');
  } else if (n === 1) {
    body = notice(b.unmatched
      ? 'suffix を認識できなかった View です。比較相手がないので単独で表示しています。'
      : `${b.viewCount} View すべてが同一ロジックです。`) +
      `<div class="vg-single">${relabelPanes(renderFragment2(
        label(groups[0]), label(groups[0]),
        build2Way(splitLines(groups[0].sql), splitLines(groups[0].sql)), o),
        [paneSub(groups[0]), paneSub(groups[0])])}</div>`;
  } else if (n === 2) {
    // 比較が 1 通りしかないので、タブ 1 枚を出しても意味がない
    body = pair(groups[0], groups[1], o);
  } else {
    body = tabs(groups, o, idPrefix);
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
    `.vg-basenote{margin:0 0 8px;color:#57606A;font-size:12px}`,
    `.vg-basenote b{color:#24292F}`,
    // タブ
    `.vg-r{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}`,
    `.vg-tablist{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #D0D7DE;margin-bottom:-1px}`,
    `.vg-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:1px solid transparent;` +
      `border-bottom:none;border-radius:6px 6px 0 0;color:#57606A;cursor:pointer;user-select:none;font-weight:600}`,
    `.vg-tab:hover{background:#EAEEF2;color:#24292F}`,
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
    // 「なぜ別グループになったか」
    `.vg-miss{background:#FFF8C5;border-color:#D4A72C}`,
    `.vg-mhint{padding:0 12px 8px;color:#54470A;font-size:12px}`,
    `.vg-mname{text-align:left;vertical-align:top;padding:3px 10px 3px 0;` +
      `font:600 12px/1.6 inherit;color:#24292F;white-space:nowrap}`,
    `.vg-mvs{vertical-align:top;padding:3px 10px 3px 0;color:#57606A;font-size:12px;white-space:nowrap}`,
    `.vg-mreason{padding:3px 0;color:#54470A;font-size:12px}`,
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
