const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-074 — 括弧付き branch が自身のセット演算を含む形の解析。
 *
 * 症状: `(SELECT id FROM aaa INTERSECT DISTINCT SELECT id FROM bbb)
 *        EXCEPT DISTINCT (SELECT id FROM ccc)` で
 *       "FromParser: JOIN was expected, but found \"INTERSECT\"" (PARTIAL_FAILURE)。
 *       演算子の種類は無関係で、UNION ALL の入れ子でも同じく落ちていた。
 *       branch が単一 SELECT の `(A) UNION ALL (B)` は通っていた。
 *
 * 原因(1): `disableSetOperations` は「この Token 列を、いま分割中のセット演算の
 *   1 branch として解析している」＝同じ深さでの再分割を防ぐフラグだが、
 *   `#stripWrappingParentheses` がこれを内側へそのまま引き継いでいた。括弧は
 *   GoogleSQL の query_expr を新しく開くので内側ではセット演算が再び合法。
 *   引き継いだ結果、内側の INTERSECT/UNION が分割されず FROM Clause の途中に
 *   演算子が残り、FromParser が JOIN を期待して落ちていた。
 *
 * 原因(2): 分割側は branch 0 の解析結果に対し `set_operations = []` と
 *   `common_table_expressions = cteResult.ctes` を無条件に代入していた。原因(1)を
 *   直すと branch 0 が自前の set_operations / CTE を持ちうるため、この上書きで
 *   内側 branch の lineage が丸ごと消える。
 *
 * 修正: 括弧を剥がす 3 経路（全体括弧 / `CREATE ... AS (...)` / CTE 直後の括弧付き
 *   本体）で `disableSetOperations: false` を渡す。分割側は branch 0 の
 *   set_operations を保存し、CTE はこの階層のものを前に連結する。
 */

const metadata = {
  analysis_id: "v1_5_0_074",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-22T00:00:00Z"
};

const cols = ["aaa", "bbb", "ccc", "ddd"].map((t) => ({
  table_name: `p.d.${t}`,
  column_name: "id",
  field_path: "id"
}));

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
    throw new Error("test_v1_5_0_074: " + message);
  }
}

function errorCodes(result) {
  return (result.exported_tables.diagnostics || [])
    .filter((d) => d.severity === "ERROR")
    .map((d) => d.code);
}

function sources(result) {
  return [...new Set((result.exported_tables.lineage_paths || []).map((p) =>
    String(p.physical_table_name || p.table_name || "").toUpperCase()
  ))].sort();
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

function expectSources(name, sql, expected) {
  const got = sources(clean(name, sql));
  assert(
    JSON.stringify(got) === JSON.stringify(expected),
    `${name}: expected sources ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`
  );
}

/*
 * 報告ケース。全 branch の物理ソースが lineage に残ること（原因(2)の回帰）まで確認する。
 */
expectSources(
  "reported: parenthesized INTERSECT branch, then EXCEPT",
  "((SELECT id FROM p.d.aaa INTERSECT DISTINCT SELECT id FROM p.d.bbb) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ccc))",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);
expectSources(
  "reported without the outer parentheses",
  "(SELECT id FROM p.d.aaa INTERSECT DISTINCT SELECT id FROM p.d.bbb) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ccc)",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);

/* 演算子の種類には依存しない（UNION ALL の入れ子でも同じ不具合だった）。 */
expectSources(
  "nested UNION ALL branch",
  "(SELECT id FROM p.d.aaa UNION ALL SELECT id FROM p.d.bbb) " +
  "UNION ALL (SELECT id FROM p.d.ccc)",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);

/* 入れ子が2段でも、右辺側でも解決する。 */
expectSources(
  "two levels of nesting",
  "((SELECT id FROM p.d.aaa UNION ALL SELECT id FROM p.d.bbb) " +
  "INTERSECT DISTINCT (SELECT id FROM p.d.ccc)) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ddd)",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC", "P.D.DDD"]
);
expectSources(
  "nested set operation on the right-hand branch",
  "SELECT id FROM p.d.aaa EXCEPT DISTINCT " +
  "((SELECT id FROM p.d.bbb) UNION ALL (SELECT id FROM p.d.ccc))",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);

/* branch 0 が自前の WITH を持っていても、その CTE が失われない（原因(2)）。 */
expectSources(
  "branch 0 carries its own WITH",
  "(WITH w AS (SELECT id FROM p.d.aaa) SELECT id FROM w " +
  "UNION ALL SELECT id FROM p.d.bbb) EXCEPT DISTINCT (SELECT id FROM p.d.ccc)",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);

/* 括弧を剥がす他の 2 経路（CREATE ... AS (...) / CTE 直後の括弧付き本体）でも同じ。 */
expectSources(
  "CREATE ... AS (nested set operation)",
  "CREATE OR REPLACE TABLE p.d.x AS " +
  "((SELECT id FROM p.d.aaa UNION ALL SELECT id FROM p.d.bbb) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ccc))",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);
expectSources(
  "WITH + parenthesized body holding a nested set operation",
  "WITH src AS (SELECT id FROM p.d.aaa) " +
  "((SELECT id FROM src INTERSECT DISTINCT SELECT id FROM p.d.bbb) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ccc))",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);

/* FROM サブクエリ位置（03 の source-discovery が落ちていた位置）。 */
expectSources(
  "nested set operation as a FROM subquery",
  "SELECT id FROM ((SELECT id FROM p.d.aaa INTERSECT DISTINCT SELECT id FROM p.d.bbb) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ccc))",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);

/* 03 の source-discovery パスは throw モードなので、そこでも通ることを固定する。 */
const discovery = JSON.parse(bundle.analyzeLineageForBigQuery(
  "((SELECT id FROM p.d.aaa INTERSECT DISTINCT SELECT id FROM p.d.bbb) " +
  "EXCEPT DISTINCT (SELECT id FROM p.d.ccc))",
  "[]",
  JSON.stringify({ source_discovery_only: true }),
  JSON.stringify(metadata)
));
assert(
  discovery.analysis.analysis_status === "COMPLETED",
  "source discovery must COMPLETE, got " + discovery.analysis.analysis_status
);
const discovered = (discovery.source_tables || []).map((t) => String(t).toLowerCase()).sort();
assert(
  JSON.stringify(discovered) === JSON.stringify(["p.d.aaa", "p.d.bbb", "p.d.ccc"]),
  "source discovery must find every branch, got " + JSON.stringify(discovered)
);

/* 回帰: 修飾子なし EXCEPT は列除外構文であってセット演算ではない。 */
const wildcardExcept = analyze("SELECT * EXCEPT(id) FROM p.d.aaa");
assert(
  wildcardExcept.analysis.analysis_status !== "PARTIAL_FAILURE" &&
  errorCodes(wildcardExcept).length === 0,
  "SELECT * EXCEPT(col) must not be treated as a set operation, got " +
  wildcardExcept.analysis.analysis_status
);

/* 回帰: 素の（括弧なし）多項セット演算。 */
expectSources(
  "flat three-branch UNION ALL",
  "SELECT id FROM p.d.aaa UNION ALL SELECT id FROM p.d.bbb UNION ALL SELECT id FROM p.d.ccc",
  ["P.D.AAA", "P.D.BBB", "P.D.CCC"]
);
expectSources(
  "single-SELECT parenthesized branches",
  "(SELECT id FROM p.d.aaa) INTERSECT DISTINCT (SELECT id FROM p.d.bbb)",
  ["P.D.AAA", "P.D.BBB"]
);

console.log(JSON.stringify({
  test: "test_v1_5_0_074",
  status: "PASS",
  issue: "括弧付き branch が自身のセット演算/CTE を含む形 " +
    "((A INTERSECT DISTINCT B) EXCEPT DISTINCT C) を解析でき、" +
    "FromParser: JOIN was expected を出さず全 branch の lineage を保持する"
}));
