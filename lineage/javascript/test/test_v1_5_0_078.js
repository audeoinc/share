const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-078 — 行値参照（テーブル別名を値として使う形）と、非予約 Keyword の明示 alias。
 *
 * (1) 行値参照
 *   GoogleSQL では `SELECT t FROM tbl AS t` の t は行全体の STRUCT で、
 *     ARRAY_AGG(t ORDER BY x LIMIT 1)[OFFSET(0)].session_id
 *   のように「グループ内の代表行を取る」定番イディオムで使われる。
 *   エンジンは t を列として解決しようとして見つけられず、物理表なら
 *   PHYSICAL_COLUMN_NOT_FOUND(ERROR)、CTE なら LINEAGE_PARTIALLY_RESOLVED(WARNING)。
 *   さらに悪いことに、本来の依存（その行の列）が系統から丸ごと落ちていた
 *   ＝ 影響分析の偽陰性。session_id を変えてもこのオブジェクトが影響先に出てこない。
 *
 *   修正: 修飾なし識別子がスコープ内の「表」ソースの別名に一致し、列として解決
 *   できないとき、行値参照として扱う。後置フィールドが分かっていれば
 *   `別名.フィールド` の修飾あり参照へ落として列単位で解決し、分からなければ
 *   `別名.*` と同じ全列依存にする。UNNEST / TABLE_FUNCTION の別名は行ではないので対象外
 *   （これを外さないと test_v1_5_0_065 の `UNNEST(Col) AS Col` を誤認する）。
 *
 * (2) 明示 alias
 *   `SELECT x AS offset` が "SelectParser: invalid explicit alias" で解析失敗していた。
 *   offset / value / key は BigQuery の予約語ではなく正当な列名。暗黙 alias 側は
 *   v1.5.0-058 で対応済みだったが、明示 alias が IDENTIFIER 限定のままだった。
 */

const metadata = {
  analysis_id: "v1_5_0_078",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-25T00:00:00Z"
};

const cols = [
  { table_name: "p.d.src", column_name: "uid", field_path: "uid" },
  { table_name: "p.d.src", column_name: "session_id", field_path: "session_id" },
  { table_name: "p.d.src", column_name: "aaa", field_path: "aaa" }
];

function analyze(sql, columns) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(columns || cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_078: " + message);
  }
}

function pairs(result) {
  return (result.exported_tables.lineage_paths || []).map((p) =>
    String(p.output_column_name || "").toUpperCase() + "<-" +
    String(p.physical_column_name || p.field_path || "").toUpperCase()
  ).sort();
}

function clean(name, sql, columns) {
  const result = analyze(sql, columns);
  const codes = (result.exported_tables.diagnostics || []).map((d) => d.code);

  assert(
    result.analysis.analysis_status === "COMPLETED",
    `${name}: expected COMPLETED, got ${result.analysis.analysis_status} ${JSON.stringify(codes)}`
  );
  return result;
}

/* ---- (1) 行値参照 ---- */

/* 報告ケース。代表行の 1 列だけに正しく依存すること（偽陰性の解消）。 */
const reported = clean(
  "ARRAY_AGG(row)[OFFSET(0)].field over a CTE",
  "WITH c AS (SELECT uid, session_id, aaa FROM p.d.src) " +
  "SELECT ARRAY_AGG(t ORDER BY aaa LIMIT 1)[OFFSET(0)].session_id AS session_id " +
  "FROM c AS t GROUP BY uid"
);
assert(
  pairs(reported).includes("SESSION_ID<-SESSION_ID"),
  "session_id must depend on the source session_id, got " + JSON.stringify(pairs(reported))
);
assert(
  pairs(reported).includes("SESSION_ID<-AAA"),
  "the ORDER BY key must stay in the lineage, got " + JSON.stringify(pairs(reported))
);
assert(
  !pairs(reported).includes("SESSION_ID<-UID"),
  "the field access must narrow to one column, not the whole row: " +
  JSON.stringify(pairs(reported))
);

/* 物理表を直接参照する形は、以前は ERROR だった。 */
const physical = clean(
  "ARRAY_AGG(row)[OFFSET(0)].field over a physical table",
  "SELECT ARRAY_AGG(t ORDER BY aaa LIMIT 1)[OFFSET(0)].session_id AS session_id " +
  "FROM p.d.src AS t GROUP BY uid"
);
assert(
  pairs(physical).includes("SESSION_ID<-SESSION_ID"),
  "physical-table form must resolve the same way, got " + JSON.stringify(pairs(physical))
);

/* CTE 越しに外から参照する、報告そのままの構造。 */
const throughCte = clean(
  "referenced through an outer CTE",
  "WITH c AS (SELECT uid, session_id, aaa FROM p.d.src), " +
  "agg AS (SELECT uid, ARRAY_AGG(t ORDER BY aaa LIMIT 1)[OFFSET(0)].session_id AS col " +
  "FROM c AS t GROUP BY uid) SELECT col FROM agg"
);
assert(
  pairs(throughCte).includes("COL<-SESSION_ID"),
  "the outer column must reach session_id, got " + JSON.stringify(pairs(throughCte))
);

/*
 * 既知の限界: 後置フィールドが無い行値（`ARRAY_AGG(t) AS xs`）は対象外のまま。
 * 「その行の全列」に相当する参照を式の途中に差し込むと下流の前提を壊すため、
 * 絞り込める形だけを扱う。ここでは「解析ごと落ちない」ことだけ固定する。
 */
const wholeRow = analyze("SELECT ARRAY_AGG(t) AS all_rows FROM p.d.src AS t");
assert(
  !(wholeRow.exported_tables.diagnostics || []).some(
    (d) => d.code === "ENGINE_STAGE_FAILED"
  ),
  "a bare row value must not crash the engine, got " +
  JSON.stringify((wholeRow.exported_tables.diagnostics || []).map((d) => d.code))
);

/* 回帰: 列と同名の別名でも、列として解決できるならそちらが勝つ。 */
const columnWins = clean(
  "a column keeps priority over a same-named source alias",
  "WITH session_id AS (SELECT uid, session_id FROM p.d.src) " +
  "SELECT session_id FROM session_id"
);
assert(
  pairs(columnWins).includes("SESSION_ID<-SESSION_ID"),
  "the column must win over the CTE alias, got " + JSON.stringify(pairs(columnWins))
);

/* 回帰: UNNEST の別名は行ではない（test_v1_5_0_065 の形）。 */
const unnestAlias = analyze(
  "SELECT Col FROM p.d.arr AS t, UNNEST(Col) AS Col",
  [{ table_name: "p.d.arr", column_name: "Col", field_path: "Col" }]
);
assert(
  (unnestAlias.exported_tables.lineage_paths || []).some(
    (p) => String(p.physical_column_name || "").toUpperCase() === "COL"
  ),
  "an UNNEST alias must not be treated as a row value"
);

/* ---- (2) 非予約 Keyword の明示 alias ---- */

for (const alias of ["offset", "value", "key", "hash", "source"]) {
  const result = clean(`explicit alias AS ${alias}`, `SELECT uid AS ${alias} FROM p.d.src`);
  assert(
    (result.exported_tables.lineage_paths || []).some(
      (p) => String(p.output_column_name || "").toUpperCase() === alias.toUpperCase()
    ),
    `AS ${alias} must produce that output column name`
  );
}

clean(
  "explicit keyword alias survives through a CTE",
  "WITH c AS (SELECT uid AS offset FROM p.d.src) SELECT offset FROM c"
);

/* 回帰: 真の予約語は alias にできない。CAST の AS も別名ではない。 */
const reserved = analyze("SELECT uid AS NULL FROM p.d.src");
assert(
  reserved.analysis.analysis_status === "PARTIAL_FAILURE",
  "AS NULL must still be rejected, got " + reserved.analysis.analysis_status
);
clean("CAST keeps its own AS", "SELECT CAST(uid AS STRING) AS s FROM p.d.src");
const backtick = clean("backticked alias", "SELECT uid AS `my id` FROM p.d.src");
assert(
  (backtick.exported_tables.lineage_paths || []).some(
    (p) => p.output_column_name === "my id"
  ),
  "backticked aliases must keep their exact text"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_078",
  status: "PASS",
  issue: "テーブル別名を行値として使う形 (ARRAY_AGG(t ORDER BY x LIMIT 1)[OFFSET(0)].col) を " +
    "解決し、後置フィールドで列単位まで絞る（影響分析の偽陰性を解消）。" +
    "併せて非予約 Keyword の明示 alias (AS offset など) の解析失敗を解消"
}));
