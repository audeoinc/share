const path = require("path");
const renderer = require(path.join(__dirname, "../src/html/usage_sql_html.js"));

/*
 * v1.5.0-075 — 使用箇所つき SQL の HTML レンダラ。
 *
 * Looker Studio の Templated Record に HTML カラムを渡して、対象 SQL を
 * 行番号つき・該当行ハイライト・該当箇所ハイライトで表示するためのもの。
 * エンジン バンドルとは独立した UDF (LNGE_USAGE_SQL_HTML) の本体になる。
 *
 * ここで固定する性質:
 *   - 既定は全文（contextLines 未指定で行が省略されない）
 *   - ハイライト位置は column_number と同じ「行頭インデントを含む文字位置」
 *   - 経路違いで重複する位置と、重なる範囲を畳む
 *   - HTML エスケープ
 *   - class モードの markup が使う class が、CSS 側にすべて存在する
 */

const SQL = [
  "SELECT",
  "    t.id,",
  "    SUM(t.amt) AS total  -- 合計",
  "FROM p.d.t AS t",
  "WHERE t.dt >= '2020-01-01'",
  "  AND t.id > 0 AND a < b"
].join("\n");

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_075: " + message);
  }
}

function rows(html) {
  return (html.match(/<tr/g) || []).length;
}

/* 既定は全文。省略行を作らない（contextLines 未指定を「前後 0 行」と誤読しないこと）。 */
const full = renderer.renderUsageSqlHtml(SQL, ["2:5:4"], null);
assert(rows(full) === 6, "default must render every line, got " + rows(full));
assert(!full.includes("行省略"), "default must not elide any line");

/* 行番号が 1 始まりで全行に出る。 */
for (let n = 1; n <= 6; n++) {
  assert(full.includes(">" + n + "</td>"), "line number " + n + " missing");
}

/* 該当行と該当箇所がハイライトされる。位置はインデントを含む文字位置。 */
const classed = renderer.renderUsageSqlHtml(SQL, ["2:5:4"], JSON.stringify({ mode: "class" }));
assert(
  classed.includes('<span class="lnge-sq-mark">t.id</span>'),
  "column 5 length 4 on line 2 must mark exactly `t.id`, got: " + classed
);
assert(
  (classed.match(/lnge-sq-row-hit/g) || []).length === 1,
  "exactly one line must carry the hit style"
);

/* 経路違いの重複と、重なり合う範囲を畳む。 */
const duplicated = renderer.renderUsageSqlHtml(
  SQL,
  ["3:9:5", "3:9:5", "3:9:5", "3:11:3"],
  JSON.stringify({ mode: "class" })
);
assert(
  (duplicated.match(/lnge-sq-mark/g) || []).length === 1,
  "duplicate and overlapping ranges must collapse into one mark, got " +
  (duplicated.match(/lnge-sq-mark/g) || []).length
);
assert(
  duplicated.includes(">t.amt</span>"),
  "merged range must cover the whole reference, got: " + duplicated
);

/* 複数行の複数箇所。 */
const many = renderer.renderUsageSqlHtml(
  SQL, ["2:5:4", "6:7:4", "6:20:1"], JSON.stringify({ mode: "class" })
);
assert(
  (many.match(/lnge-sq-mark/g) || []).length === 3,
  "three distinct positions must produce three marks"
);
assert(
  (many.match(/lnge-sq-row-hit/g) || []).length === 2,
  "two distinct lines must be flagged as hit"
);

/* HTML エスケープ。`a < b` の '<' がタグとして解釈されない。 */
assert(full.includes("&lt;"), "'<' must be escaped");
assert(!/[^&];[^;]*<b/.test(full), "raw '<b' must not appear");

/* 不正な位置指定は落とさず読み飛ばす。 */
const junk = renderer.renderUsageSqlHtml(
  SQL, ["", "abc", "0:0:0", "9999:1:1", null, "2:5:4"], JSON.stringify({ mode: "class" })
);
assert(
  (junk.match(/lnge-sq-mark/g) || []).length === 1,
  "malformed entries must be skipped, the valid one kept"
);

/* 壊れた options_json でも描画を諦めない。 */
const broken = renderer.renderUsageSqlHtml(SQL, ["2:5:4"], "{not json");
assert(rows(broken) === 6, "broken options JSON must fall back to defaults");

/* 空入力。 */
assert(renderer.renderUsageSqlHtml(null, ["1:1:1"], null) === "", "NULL sql must render empty");
assert(renderer.renderUsageSqlHtml("", ["1:1:1"], null) === "", "empty sql must render empty");
assert(
  rows(renderer.renderUsageSqlHtml(SQL, null, null)) === 6,
  "missing highlights must still render the SQL"
);

/* モード。 */
const embed = renderer.renderUsageSqlHtml(SQL, ["2:5:4"], null);
assert(embed.startsWith("<style>"), "embed (default) must be self-contained");
assert(!classed.includes("<style>"), "class mode must not embed CSS");
const inline = renderer.renderUsageSqlHtml(SQL, ["2:5:4"], JSON.stringify({ mode: "inline" }));
assert(!inline.includes("class="), "inline mode must not emit class attributes");
assert(inline.includes("style="), "inline mode must emit style attributes");
assert(
  classed.length < inline.length,
  "class markup must be smaller than inline markup"
);

/* class モードの markup が使う class は、CSS にすべて定義されている。 */
const css = renderer.buildUsageSqlCss(null);
const used = new Set((classed.match(/class="([^"]+)"/g) || []).map(
  (m) => m.replace(/class="|"/g, "")
));
for (const name of used) {
  assert(css.includes("." + name + "{"), "CSS rule missing for class " + name);
}

/* contextLines を指定したときだけ窓になる。 */
const windowed = renderer.renderUsageSqlHtml(
  SQL, ["6:7:4"], JSON.stringify({ mode: "class", contextLines: 1 })
);
assert(windowed.includes("行省略"), "contextLines must elide distant lines");
assert(windowed.includes(">5</td>") && windowed.includes(">6</td>"), "context lines must survive");
assert(!windowed.includes(">1</td>"), "lines outside the window must be elided");

/* maxLines で打ち切り、打ち切った旨を出す。 */
const long = Array.from({ length: 50 }, (_, i) => "SELECT " + i).join("\n");
const capped = renderer.renderUsageSqlHtml(long, [], JSON.stringify({ mode: "class", maxLines: 10 }));
assert(capped.includes("maxLines"), "truncation must be announced");
assert(rows(capped) === 11, "10 line rows plus the notice row, got " + rows(capped));

/* 構文ハイライトは位置ハイライトと併存する。 */
assert(classed.includes("lnge-sq-kw"), "keywords must be coloured");
assert(classed.includes("lnge-sq-cm"), "line comments must be coloured");
assert(classed.includes("lnge-sq-li"), "literals must be coloured");

/* BigQuery の raw string リテラルを壊す並びを含まない。 */
const source = require("fs").readFileSync(
  path.join(__dirname, "../src/html/usage_sql_html.js"), "utf8"
);
assert(!source.includes("'''") && !source.includes('"""'),
  "the renderer must not contain ''' or \"\"\" (it is embedded in a raw string literal)");

console.log(JSON.stringify({
  test: "test_v1_5_0_075",
  status: "PASS",
  issue: "使用箇所つき SQL の HTML レンダラ。既定は全文、行番号つき、該当行と" +
    "該当箇所（複数・重複と重なりを畳む）をハイライト、class/inline/embed の3モード、" +
    "class の markup と CSS が食い違わない"
}));
