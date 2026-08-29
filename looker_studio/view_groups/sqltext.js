'use strict';
/**
 * View の SQL そのもの（INFORMATION_SCHEMA.VIEWS.view_definition）を出すタブ。
 *
 * ロジック差分のタブは「グループ同士の違い」を見るためのもので、出しているのは
 * パラメータ化した SQL（実体名や値が {{Pn}} に置き換わったもの）。読み比べには
 * それでよいが、**その View に実際に何が書いてあるか** を知りたいときには使えない。
 * 置き換えた箇所は末尾の一覧か tooltip を辿らないと分からないし、そもそも
 * グループの代表 1 本ぶんしか出ていない。
 *
 * ここは逆に、差分も等価判定も通さない素のテキストをそのまま出す。
 *
 * **インナーのタブはグループではなく suffix。** グループは「同じロジックの束」
 * なので、束の中のどれを見ても同じ SQL になる（だからグループにまとまっている）。
 * 素の SQL を見に来る人が探しているのは「abjp の SQL」であって「グループ 2 の
 * SQL」ではないので、View を 1 本ずつ選べる形にする。並びは suffix 順で、
 * どのグループに属しているかはパネルの見出しに出す。
 *
 * 見た目の作りは参照関係・カラム定義と同じで、JavaScript は使わない
 * （radio + :checked の CSS だけ）。クラスの頭は .vg-s* で、外側（.vg-o*）・
 * 基準（.vg-b*）・比較（.vg-r/t/p）のどれとも重ならないようにしてある。
 * 重なると一方のラジオがもう一方の :checked ~ に引っかかり、片方を押すと
 * もう片方も切り替わる。
 */

const { esc, hashId, label, notice, MAX_SQL_TABS } = require('./chrome.js');

/**
 * base の全 View を 1 列に並べる。これがそのままタブの並びになる。
 * suffix 順にするのは、探すときの手掛かりが suffix だから
 * （グループ順に並べると、同じ suffix を探すのにタブを目で追うことになる）。
 */
function sqlViews(b) {
  const out = [];
  const groups = b.groups || [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const members = g.members || [];
    for (let j = 0; j < members.length; j++) {
      out.push({
        suffix: (g.suffixes && g.suffixes[j]) || members[j].viewName || '(suffix なし)',
        viewName: members[j].viewName,
        group: label(g),
        groupSize: members.length,
      });
    }
  }
  out.sort((x, y) => String(x.suffix).localeCompare(String(y.suffix)));
  return out;
}

/**
 * SQL 本文。行番号を付けて <pre> で出す。
 *
 * 行番号は CSS のカウンタではなく本文として書く。カウンタは埋め込み先で
 * 効かなければ番号が丸ごと消えるが、テキストなら必ず出る（この画面では
 * 指定した CSS がそのまま効かない場面を何度か踏んでいる）。桁を空白で
 * そろえるだけなので、<pre> と等幅フォントがあれば位置も合う。
 *
 * 折り返さない（white-space:pre）。SQL は字下げが構造を表しているので、
 * 折り返すと読みにくくなる。横は箱ごとスクロールさせる。
 */
function sqlBody(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  // 末尾の空行は落とす。view_definition には改行が 1 つ余分に付くことがある。
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  const w = String(lines.length).length;
  const rows = lines.map((t, i) => {
    const n = String(i + 1);
    return `<span class="vg-sqln">${new Array(w - n.length + 1).join(' ')}${n}</span> ` +
      esc(t);
  }).join('\n');
  return { html: `<div class="vg-sqlbox"><pre class="vg-sqlpre">${rows}</pre></div>`,
    lines: lines.length };
}

/** タブ 1 枚ぶんの中身。View 名とグループを添えてから本文を出す。 */
function sqlPanel(v, text) {
  if (text == null || String(text) === '') {
    return `<div class="vg-sqlhead"><span class="vg-sqlname">${esc(v.viewName)}</span></div>` +
      notice('この View の SQL を取得できませんでした。');
  }
  const body = sqlBody(text);
  // どのグループに属しているかは、素の SQL を読むときの前提になる
  // （同じ内容の View がほかにもあるのかどうか）。
  return `<div class="vg-sqlhead">` +
    `<span class="vg-sqlname">${esc(v.viewName)}</span>` +
    `<span class="vg-sqlmeta">グループ: ${esc(v.group)}</span>` +
    `<span class="vg-sqlmeta">${body.lines} 行</span>` +
    `</div>` + body.html;
}

/**
 * base 1 件分の SQL タブ。
 * @param {object} b      解析結果の base 1 件分
 * @param {object} byView { View 名: SQL 本文 }
 */
function renderSql(b, byView) {
  const views = sqlViews(b);
  if (!views.length) return notice('View が見つかりません。');
  const src = byView || {};
  if (!views.some((v) => src[v.viewName])) {
    return notice('SQL を取得できませんでした。' +
      'INFORMATION_SCHEMA.VIEWS から view_definition が読めているか確認してください。');
  }

  const shown = views.slice(0, MAX_SQL_TABS);
  const idPrefix = 'vgs' + hashId(b.base + '|' + views.map((v) => v.viewName).join('|'));
  const radios = shown.map((_, i) =>
    `<input class="vg-sr vg-sr${i + 1}" type="radio" name="${idPrefix}"` +
    ` id="${idPrefix}-${i + 1}"${i === 0 ? ' checked' : ''}>`).join('');
  const tablist = shown.map((v, i) =>
    `<label class="vg-stab vg-st${i + 1}" for="${idPrefix}-${i + 1}">` +
    `${esc(v.suffix)}</label>`).join('');
  const panels = shown.map((v, i) =>
    `<div class="vg-spanel vg-sp${i + 1}">${sqlPanel(v, src[v.viewName])}</div>`).join('');

  // 打ち切ったときは、なぜ選べないのかを出す。タブが足りないだけだと、
  // 故障なのか設計なのか読み取れない。
  const over = views.length > shown.length
    ? notice(`View が多いため先頭 ${MAX_SQL_TABS} 件のみタブ表示しています` +
      `（全 ${views.length} 件）。`)
    : '';

  return over +
    `<div class="vg-stabs">${radios}` +
    `<div class="vg-stablist"><span class="vg-slabel">View</span>${tablist}</div>` +
    `<div class="vg-spanels">${panels}</div></div>`;
}

/** base 1 件分。見出しは外枠（wrapPage）が出すので、ここでは中身だけ。 */
function renderSqlBase(b, byView) {
  return `<div class="vg-root">${renderSql(b, byView)}</div>`;
}

/**
 * このファイルが出す markup に対応する CSS。
 * columns.js / markdown.js と同じ考え方で、クラス名を付けている側に置く。
 * 配る 1 枚は viewlgc_group_css が chromeCss() などと連結して作る。
 */
function sqlCss() {
  const rules = [
    // タブ。ラジオは画面から隠すが、display:none にはしない（キーボードで
    // 辿れなくなるうえ、ブラウザによっては :checked が働かない）。
    `.vg-sr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}`,
    `.vg-stablist{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 10px}`,
    `.vg-slabel{color:#57606A;font-size:12px;font-weight:600;margin-right:2px}`,
    `.vg-stab{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;` +
      `border:1px solid #D0D7DE;border-radius:14px;color:#57606A;` +
      `cursor:pointer;user-select:none;font-weight:600;font-size:12px;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-stab:hover{background:#EAEEF2;color:#24292F}`,
    `.vg-spanel{display:none}`,
    // パネルの見出し。View 名・属するグループ・行数。
    `.vg-sqlhead{display:flex;align-items:center;flex-wrap:wrap;gap:10px;` +
      `padding:7px 12px;border:1px solid #D0D7DE;border-bottom:none;` +
      `border-radius:6px 6px 0 0;background:#F6F8FA}`,
    `.vg-sqlname{font-weight:600;font-size:12px;line-height:1.6;color:#24292F;` +
      `font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`,
    `.vg-sqlmeta{color:#57606A;font-size:11px;line-height:1.6}`,
    // 本文。SQL は字下げが構造を表しているので折り返さず、箱ごと横スクロール
    // させる（カラム定義の表とは事情が逆）。この箱の中に貼り付く要素は無いので、
    // ここがスクロール要素になっても sticky の邪魔はしない。
    `.vg-sqlbox{overflow-x:auto;border:1px solid #D0D7DE;border-radius:0 0 6px 6px;` +
      `background:#fff}`,
    `.vg-sqlpre{margin:0;padding:8px 12px;white-space:pre;` +
      `font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:#24292F}`,
    // 行番号。本文と同じ等幅なので、空白で桁をそろえれば位置が合う。
    `.vg-sqln{color:#8C959F;user-select:none}`,
  ];
  // タブ本体。ID ではなくクラスで書くので、レコードが変わってもこの CSS のまま。
  // 形は「兄弟 > 子」から動かさない。この viz で radio + :checked が動くと
  // 確かめたときの形がこれ（templated_record/samples/07_radio_tabs_test.html）。
  // 選択中は青系にして、外側（黒）・基準（薄い赤）と見分けられるようにする。
  for (let i = 1; i <= MAX_SQL_TABS; i++) {
    rules.push(`.vg-sr${i}:checked ~ .vg-spanels > .vg-sp${i}{display:block}`);
    rules.push(`.vg-sr${i}:checked ~ .vg-stablist > .vg-st${i}` +
      `{background:#DDF4FF;border-color:#54AEFF;color:#0969DA}`);
  }
  return rules.join('\n');
}

module.exports = { renderSql, renderSqlBase, sqlCss, sqlViews, sqlBody, sqlPanel };
