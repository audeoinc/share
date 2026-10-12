const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-076 — DDL の前置き（CREATE ... AS / EXPORT DATA ... AS）を落として本体を解析する。
 *
 * 症状: `CREATE OR REPLACE TABLE t AS WITH c AS (SELECT ...) SELECT ... FROM c` で
 *       系統が空になる。エラーではなく COMPLETED_WITH_WARNINGS になるため、
 *       依存が静かに欠落する。
 *
 * 原因: #parseCommonTableExpressions は「先頭 Token が WITH」のときしか CTE を解析しない。
 *       CREATE で始まると CTE が読まれず、ClauseParser が拾う深さ0の SELECT だけが残り、
 *       CTE 名が未知のソースとして PHYSICAL_METADATA_NOT_FOUND(WARNING) になる。
 *       前置きの無い `CREATE ... AS SELECT ...` は ClauseParser が深さ0の SELECT を
 *       拾えるので通っていたため、この形だけが抜けていた。
 *
 * 修正: #stripStatementPrefix を追加。先頭が CREATE / EXPORT のとき、深さ0の最初の 'AS'
 *       の直後（SELECT / WITH / '(' で始まること）から本体として再解析する。
 *       深さ0の AS を境界にするので、列スキーマ・PARTITION BY・CLUSTER BY・OPTIONS が
 *       どう並んでも影響を受けない（いずれも括弧の中か AS より前）。
 */

const metadata = {
  analysis_id: "v1_5_0_076",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-25T00:00:00Z"
};

const cols = [
  { table_name: "p.d.src", column_name: "id", field_path: "id" },
  { table_name: "p.d.src", column_name: "amt", field_path: "amt" }
];

function analyze(sql) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_076: " + message);
  }
}

function sources(result) {
  return [...new Set((result.exported_tables.lineage_paths || []).map((p) =>
    String(p.physical_table_name || p.table_name || "").toUpperCase()
  ))].sort();
}

/* 系統が p.d.src に解決し、警告もエラーも出ないこと。 */
function tracesToSrc(name, sql) {
  const result = analyze(sql);
  const got = sources(result);

  assert(
    JSON.stringify(got) === JSON.stringify(["P.D.SRC"]),
    `${name}: expected lineage to P.D.SRC, got ${JSON.stringify(got)} ` +
    `(status ${result.analysis.analysis_status})`
  );
  assert(
    result.analysis.analysis_status === "COMPLETED",
    `${name}: expected COMPLETED, got ${result.analysis.analysis_status} ` +
    JSON.stringify((result.exported_tables.diagnostics || []).map((d) => d.code))
  );
  return result;
}

/* 報告ケース: CTE 付き CTAS。修正前はここだけ系統が空になっていた。 */
tracesToSrc(
  "CTAS with a CTE body",
  "CREATE OR REPLACE TABLE p.d.tgt AS WITH c AS (SELECT id, amt FROM p.d.src) SELECT id, amt FROM c"
);

/*
 * 前置きの各要素。深さ0の AS を境界にしているので、どの組み合わせでも同じ結果になる
 * （03 の正規表現のように形ごとの列挙を必要としないことを固定する）。
 */
tracesToSrc("CTAS bare", "CREATE OR REPLACE TABLE p.d.tgt AS SELECT id, amt FROM p.d.src");
tracesToSrc("CTAS backticked name", "CREATE OR REPLACE TABLE `p.d.tgt` AS SELECT id FROM p.d.src");
tracesToSrc("CTAS IF NOT EXISTS", "CREATE TABLE IF NOT EXISTS p.d.tgt AS SELECT id FROM p.d.src");
tracesToSrc("CTAS TEMP", "CREATE TEMP TABLE t AS SELECT id FROM p.d.src");
tracesToSrc(
  "CTAS OPTIONS",
  "CREATE OR REPLACE TABLE p.d.tgt OPTIONS(description='x') AS SELECT id FROM p.d.src"
);
tracesToSrc(
  "CTAS PARTITION BY / CLUSTER BY",
  "CREATE OR REPLACE TABLE p.d.tgt PARTITION BY DATE(dt) CLUSTER BY id " +
  "AS SELECT id, amt FROM p.d.src"
);
tracesToSrc(
  "CTAS column schema",
  "CREATE OR REPLACE TABLE p.d.tgt (id INT64, amt INT64) AS SELECT id, amt FROM p.d.src"
);
tracesToSrc(
  "CTAS everything at once, with a CTE body",
  "CREATE OR REPLACE TABLE p.d.tgt (id INT64) PARTITION BY DATE(dt) CLUSTER BY id " +
  "OPTIONS(description='x') AS WITH c AS (SELECT id FROM p.d.src) SELECT id FROM c"
);
tracesToSrc("CREATE VIEW", "CREATE OR REPLACE VIEW p.d.v AS SELECT id, amt FROM p.d.src");
tracesToSrc(
  "CREATE MATERIALIZED VIEW",
  "CREATE MATERIALIZED VIEW p.d.mv AS SELECT id FROM p.d.src"
);
tracesToSrc(
  "EXPORT DATA with a CTE body",
  "EXPORT DATA OPTIONS(uri='gs://b/*.csv', format='CSV') " +
  "AS WITH c AS (SELECT id FROM p.d.src) SELECT id FROM c"
);
tracesToSrc(
  "CTAS parenthesized body",
  "CREATE OR REPLACE TABLE p.d.tgt AS (SELECT id FROM p.d.src)"
);
tracesToSrc(
  "CTAS set operation body",
  "CREATE OR REPLACE TABLE p.d.tgt AS " +
  "SELECT id FROM p.d.src UNION ALL SELECT id FROM p.d.src"
);

/*
 * 回帰: 前置きの無いクエリには一切触れないこと。特に `WITH t AS (...)` の AS を
 * 境界と誤認すると CTE ごと捨ててしまうので、ここは必ず守る。
 */
tracesToSrc("plain SELECT", "SELECT id, amt FROM p.d.src");
tracesToSrc("plain WITH", "WITH c AS (SELECT id FROM p.d.src) SELECT id FROM c");
tracesToSrc(
  "WITH whose CTE body is itself parenthesized",
  "WITH c AS (SELECT id FROM p.d.src) (SELECT id FROM c)"
);
tracesToSrc("INSERT ... SELECT", "INSERT INTO p.d.tgt (id) SELECT id FROM p.d.src");

/* 回帰: SELECT 項目の別名 AS は境界にならない。 */
const aliased = tracesToSrc(
  "column alias survives",
  "CREATE OR REPLACE TABLE p.d.tgt AS SELECT id AS renamed FROM p.d.src"
);
assert(
  (aliased.exported_tables.lineage_paths || []).some(
    (p) => String(p.output_column_name || "").toUpperCase() === "RENAMED"
  ),
  "the aliased output column must be RENAMED"
);

/* 前置きだけで本体クエリが無い DDL は、従来どおり解析対象にならない。 */
const noBody = analyze("CREATE TABLE p.d.tgt (id INT64)");
assert(
  noBody.analysis.analysis_status === "PARTIAL_FAILURE",
  "a DDL with no query body must still fail, got " + noBody.analysis.analysis_status
);

console.log(JSON.stringify({
  test: "test_v1_5_0_076",
  status: "PASS",
  issue: "CREATE ... AS / EXPORT DATA ... AS の前置きを落として本体を解析する。" +
    "CTE 付き CTAS で系統が静かに欠落する問題を解消し、列スキーマ・PARTITION BY・" +
    "CLUSTER BY・OPTIONS のどの組み合わせでも前置きの形に依存しない"
}));
