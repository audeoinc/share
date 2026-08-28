const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-077 — 別名なし UNNEST の要素フィールドをドット付きで参照した形。
 *
 * 症状: DAG の SQL
 *   COALESCE((SELECT value.string_value FROM UNNEST(event_params) WHERE key='utm_campaign'),
 *            (SELECT value.string_value FROM UNNEST(event_params) WHERE key='campaign')) AS campaign
 * で LINEAGE_PARTIALLY_RESOLVED（... @scope N (EXPRESSION_SUBQUERY) [UNRESOLVED_SOURCE]）。
 *
 * 原因: 式サブクエリは無関係で、条件は「別名なし UNNEST × ドット付き参照」。
 *   ColumnResolver は 2 部構成の識別子を「修飾子.列名」と読むため、`value.string_value` の
 *   先頭 `value` をソース別名とみなす。別名なし UNNEST に一致するソースは無いので
 *   UNRESOLVED_SOURCE。単一部の `key` は修飾なし参照として既存の UNNEST フォールバックが
 *   拾うため、ドット付きだけが取り残されていた。別名を付けた `ep.value.string_value` は
 *   ColumnResolver が別名を解決するので通っていた。
 *
 * 修正: PhysicalColumnResolver で、修飾ありかつ UNRESOLVED_SOURCE の参照は、スコープ内の
 *   UNNEST が 1 つだけなら修飾子ごと要素内フィールドパスとみなして UNNEST 解決へ委譲する。
 *   物理のネスト STRUCT（geo.region）は先行する #resolveStructFieldPathReference が
 *   解決するため優先順位は変わらない。UNNEST が複数あるスコープは決められないので従来どおり。
 */

const metadata = {
  analysis_id: "v1_5_0_077",
  view_project: "P",
  view_dataset: "D",
  view_name: "V",
  analyzed_at: "2026-08-25T00:00:00Z"
};

const ga4 = [
  { table_name: "p.d.ev", column_name: "id", field_path: "id" },
  { table_name: "p.d.ev", column_name: "event_params", field_path: "event_params" },
  { table_name: "p.d.ev", column_name: "event_params", field_path: "event_params.key" },
  { table_name: "p.d.ev", column_name: "event_params", field_path: "event_params.value" },
  {
    table_name: "p.d.ev",
    column_name: "event_params",
    field_path: "event_params.value.string_value"
  }
];

function analyze(sql, cols) {
  return JSON.parse(bundle.analyzeLineageForBigQuery(
    sql,
    JSON.stringify(cols || ga4),
    JSON.stringify({ strict_mode: false }),
    JSON.stringify(metadata)
  ));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_077: " + message);
  }
}

function fieldPaths(result, outputColumn) {
  return (result.exported_tables.lineage_paths || [])
    .filter((p) => String(p.output_column_name || "").toUpperCase() === outputColumn)
    .map((p) => String(p.field_path || p.physical_column_name || "").toUpperCase())
    .sort();
}

function clean(name, sql, cols) {
  const result = analyze(sql, cols);
  const codes = (result.exported_tables.diagnostics || []).map((d) => d.code);

  assert(
    result.analysis.analysis_status === "COMPLETED",
    `${name}: expected COMPLETED, got ${result.analysis.analysis_status} ${JSON.stringify(codes)}`
  );
  assert(
    !codes.includes("LINEAGE_PARTIALLY_RESOLVED"),
    `${name}: must not report PARTIALLY_RESOLVED`
  );
  return result;
}

/* 報告ケース。COALESCE で式サブクエリを 2 つ並べた GA4 の定番。 */
const reported = clean(
  "COALESCE of two expression subqueries over an unaliased UNNEST",
  "SELECT id, COALESCE(" +
  "(SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'utm_campaign')," +
  "(SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'campaign')" +
  ") AS campaign FROM p.d.ev"
);
assert(
  fieldPaths(reported, "CAMPAIGN").includes("EVENT_PARAMS.VALUE.STRING_VALUE"),
  "campaign must trace to event_params.value.string_value, got " +
  JSON.stringify(fieldPaths(reported, "CAMPAIGN"))
);

/* 式サブクエリは無関係であること: FROM 句でも同じ形が通る。 */
const inFrom = clean(
  "unaliased UNNEST in the FROM clause, dotted reference",
  "SELECT value.string_value AS campaign FROM p.d.ev, UNNEST(event_params) WHERE key = 'campaign'"
);
assert(
  fieldPaths(inFrom, "CAMPAIGN").includes("EVENT_PARAMS.VALUE.STRING_VALUE"),
  "FROM-clause form must resolve the same way"
);

/* 配列引数が修飾されていても、JOIN が居ても同じ。 */
clean(
  "qualified array argument",
  "SELECT t.id, (SELECT value.string_value FROM UNNEST(t.event_params) WHERE key = 'c') " +
  "AS campaign FROM p.d.ev AS t"
);
clean(
  "outer join present",
  "SELECT a.id, (SELECT value.string_value FROM UNNEST(a.event_params) WHERE key = 'c') " +
  "AS campaign FROM p.d.ev AS a JOIN p.d.ev AS b ON a.id = b.id"
);
clean(
  "LIMIT 1 inside the subquery",
  "SELECT id, (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'c' LIMIT 1) " +
  "AS campaign FROM p.d.ev"
);

/* 回帰: 別名付きと単一部参照は従来どおり。 */
clean(
  "aliased element reference still resolves",
  "SELECT id, (SELECT ep.value.string_value FROM UNNEST(event_params) AS ep " +
  "WHERE ep.key = 'c') AS campaign FROM p.d.ev"
);
clean(
  "single-part element reference still resolves",
  "SELECT id, (SELECT key FROM UNNEST(event_params) LIMIT 1) AS k FROM p.d.ev"
);

/* 回帰: 物理テーブルのネスト STRUCT は UNNEST に横取りされない。 */
const nested = clean(
  "physical nested STRUCT keeps priority over the UNNEST fallback",
  "SELECT geo.region AS r, (SELECT value.string_value FROM UNNEST(event_params) " +
  "WHERE key = 'c') AS campaign FROM p.d.t, p.d.ev",
  ga4.concat([
    { table_name: "p.d.t", column_name: "geo", field_path: "geo" },
    { table_name: "p.d.t", column_name: "geo", field_path: "geo.region" }
  ])
);
assert(
  fieldPaths(nested, "R").includes("GEO.REGION"),
  "geo.region must still resolve to the physical table, got " +
  JSON.stringify(fieldPaths(nested, "R"))
);

/*
 * スコープに UNNEST が 2 つあるときは、どの要素の `value` か決められないので
 * 従来どおり解決しない。誤った帰属を作らないことを固定する。
 */
const twoUnnests = analyze(
  "SELECT (SELECT value.string_value FROM UNNEST(event_params) AS a, UNNEST(event_params) AS b " +
  "WHERE a.key = 'c') AS campaign FROM p.d.ev"
);
assert(
  fieldPaths(twoUnnests, "CAMPAIGN").every((f) => f !== "EVENT_PARAMS.VALUE.STRING_VALUE") ||
  twoUnnests.analysis.analysis_status !== "COMPLETED",
  "two UNNEST sources must not be silently attributed to one of them"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_077",
  status: "PASS",
  issue: "別名なし UNNEST の要素フィールドをドット付きで参照した形 " +
    "(GA4 の value.string_value) が UNRESOLVED_SOURCE になり誤った " +
    "LINEAGE_PARTIALLY_RESOLVED を出す問題を解消。別名付き・単一部参照・" +
    "物理ネスト STRUCT の優先順位は不変"
}));
