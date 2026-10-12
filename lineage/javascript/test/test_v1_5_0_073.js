const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-073 — WITH 句の後ろのメインQueryが括弧で包まれた形を解析できない不具合の修正。
 *
 * 症状: `WITH aaa AS (SELECT * FROM t)(SELECT col FROM aaa)` で QueryParser が
 * 「トップレベルのSELECT Clauseが見つかりません」を throw する。括弧なしの
 * `WITH aaa AS (...) SELECT ...` と、全体を包む `(WITH ... SELECT ...)` は通っていた。
 *
 * 原因: GoogleSQL の query_expr は `[WITH ...] { select | ( query_expr ) | set_op }`
 * なので CTE の後ろの括弧付きクエリは正しい構文。しかし ClauseParser は深さ0の
 * SELECT を探すため、この形では SELECT が括弧内（深さ1）に入り見つからなかった。
 * 既存の `#stripWrappingParentheses` は「クエリ先頭が '('」の場合しか剥がさず、
 * `#stripStatementBodyParentheses` は「深さ0の AS の直後」しか見ないため、
 * どちらもこの形には当たらない。
 *
 * 修正: CTE 解析後、メインQuery部分（main_start_index 以降）が丸ごと括弧に
 * 包まれていれば、その内側をメインQueryとして再解析し、この階層の CTE を
 * 前に連結する（外側 CTE が先に定義される順序を保つ）。
 */

const metadata = {
  analysis_id: "v1_5_0_073",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-22T00:00:00Z"
};

const cols = [
  { table_name: "p.d.dddd", column_name: "col", field_path: "col" },
  { table_name: "p.d.dddd", column_name: "col2", field_path: "col2" }
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
    throw new Error("test_v1_5_0_073: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function pathPairs(result) {
  return (result.exported_tables.lineage_paths || []).map((p) =>
    String(p.output_column_name || "").toUpperCase() + "<-" +
    String(p.physical_table_name || p.table_name || "").toUpperCase() + "." +
    String(p.physical_column_name || p.field_path || "").toUpperCase()
  );
}

function clean(name, sql) {
  const result = analyze(sql);
  assert(
    result.analysis.analysis_status !== "PARTIAL_FAILURE" &&
    errorCodes(result).length === 0,
    `${name}: expected clean parse, got ${result.analysis.analysis_status} ` +
    JSON.stringify(errorCodes(result)) + " " +
    (JSON.parse(result.analysis.error_detail_json || "{}").message || "")
  );
  return result;
}

/* 報告ケース: 括弧の前に空白すら無い形。 */
const reported = clean(
  "WITH + parenthesized main query",
  "WITH aaa AS (select * from p.d.dddd)(select col FROM aaa)"
);
assert(
  pathPairs(reported).includes("COL<-P.D.DDDD.COL"),
  "reported case lineage expected, got " + JSON.stringify(pathPairs(reported))
);

/* 改行・末尾 ';' などの表記ゆれ。 */
clean(
  "newline before paren",
  "WITH aaa AS (SELECT * FROM p.d.dddd)\n(SELECT col FROM aaa)"
);
clean(
  "trailing semicolon",
  "WITH aaa AS (SELECT col FROM p.d.dddd) (SELECT col FROM aaa);"
);

/* 複数 CTE でも main_start_index 以降だけが剥がれる。 */
const multiCte = clean(
  "multiple CTEs",
  "WITH a AS (SELECT col FROM p.d.dddd), b AS (SELECT col FROM a) (SELECT col FROM b)"
);
assert(
  pathPairs(multiCte).includes("COL<-P.D.DDDD.COL"),
  "multiple CTE lineage expected, got " + JSON.stringify(pathPairs(multiCte))
);

/* 括弧内がセット演算 / さらに WITH を持つ場合も解決する。 */
const innerUnion = clean(
  "parenthesized set operation body",
  "WITH a AS (SELECT col FROM p.d.dddd) " +
  "((SELECT col FROM a) UNION ALL (SELECT col FROM a))"
);
assert(
  pathPairs(innerUnion).includes("COL<-P.D.DDDD.COL"),
  "inner union lineage expected, got " + JSON.stringify(pathPairs(innerUnion))
);

const innerWith = clean(
  "parenthesized body with its own WITH",
  "WITH a AS (SELECT col FROM p.d.dddd) (WITH b AS (SELECT col FROM a) SELECT col FROM b)"
);
assert(
  pathPairs(innerWith).includes("COL<-P.D.DDDD.COL"),
  "inner WITH lineage expected, got " + JSON.stringify(pathPairs(innerWith))
);

/* RECURSIVE 指定が括弧付き本体でも保持される。 */
clean(
  "WITH RECURSIVE + parenthesized body",
  "WITH RECURSIVE a AS (SELECT col FROM p.d.dddd) (SELECT col FROM a)"
);

/* 回帰: 従来通り通っていた形を壊していないこと。 */
clean("bare CTE body", "WITH a AS (SELECT col FROM p.d.dddd) SELECT col FROM a");
clean("whole query wrapped", "(WITH a AS (SELECT col FROM p.d.dddd) SELECT col FROM a)");
clean(
  "CTE then top-level set operation",
  "WITH a AS (SELECT col FROM p.d.dddd) (SELECT col FROM a) UNION ALL (SELECT col FROM a)"
);
clean(
  "CTAS with parenthesized CTE body",
  "CREATE OR REPLACE TABLE p.d.x AS " +
  "(WITH a AS (SELECT col FROM p.d.dddd) SELECT col FROM a)"
);
const scalarSubquery = clean(
  "CTE body with scalar subquery",
  "WITH a AS (SELECT col, col2 FROM p.d.dddd) " +
  "(SELECT col, (SELECT MAX(col2) FROM a) AS m FROM a)"
);
assert(
  pathPairs(scalarSubquery).includes("COL<-P.D.DDDD.COL"),
  "scalar subquery case lineage expected, got " + JSON.stringify(pathPairs(scalarSubquery))
);

console.log(JSON.stringify({
  test: "test_v1_5_0_073",
  status: "PASS",
  issue: "WITH 句の後ろのメインQueryが括弧で包まれた形 " +
    "(WITH cte AS (...) (SELECT ...)) を解析でき、" +
    "『トップレベルのSELECT Clauseが見つかりません』を出さない"
}));
