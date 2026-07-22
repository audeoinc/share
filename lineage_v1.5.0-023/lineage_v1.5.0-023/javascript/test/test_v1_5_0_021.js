"use strict";

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const bundlePath = path.resolve(__dirname, "../dist/lineage_udf_bundle.js");
vm.runInThisContext(fs.readFileSync(bundlePath, "utf8"), { filename: bundlePath });

const sql = [
  "SELECT",
  "  customer_id,",
  "  metric_name,",
  "  metric_value",
  "FROM",
  "  `audeodb.sample_ds.t_diagnostic_unpivot_source`",
  "UNPIVOT",
  "(",
  "  metric_value FOR metric_name IN",
  "  (sales_amount, cost_amount)",
  ")"
].join("\n");

const result = new LineageEngine({
  strictMode: false,
  physicalColumns: [
    {
      project_id: "AUDEODB",
      dataset_id: "SAMPLE_DS",
      table_name: "T_DIAGNOSTIC_UNPIVOT_SOURCE",
      column_name: "CUSTOMER_ID"
    },
    {
      project_id: "AUDEODB",
      dataset_id: "SAMPLE_DS",
      table_name: "T_DIAGNOSTIC_UNPIVOT_SOURCE",
      column_name: "SALES_AMOUNT"
    },
    {
      project_id: "AUDEODB",
      dataset_id: "SAMPLE_DS",
      table_name: "T_DIAGNOSTIC_UNPIVOT_SOURCE",
      column_name: "COST_AMOUNT"
    }
  ]
}).analyze(sql);

const diagnostic = result.diagnostics.find((item) => {
  return item.code === "PHYSICAL_COLUMN_NOT_FOUND" &&
    item.column_name === "METRIC_NAME";
});

assert.ok(diagnostic);
assert.strictEqual(diagnostic.scope_type, "ROOT_QUERY");
assert.strictEqual(
  diagnostic.candidate_source_name,
  "AUDEODB.SAMPLE_DS.T_DIAGNOSTIC_UNPIVOT_SOURCE"
);
assert.deepStrictEqual(
  diagnostic.candidate_source_names,
  ["AUDEODB.SAMPLE_DS.T_DIAGNOSTIC_UNPIVOT_SOURCE"]
);
assert.strictEqual(
  diagnostic.resolved_source_name,
  "AUDEODB.SAMPLE_DS.T_DIAGNOSTIC_UNPIVOT_SOURCE"
);
assert.strictEqual(diagnostic.sql_context, "metric_name");

console.log(JSON.stringify({
  status: "PASS",
  issue: "Diagnostic scope/source enrichment and AST SQL context"
}, null, 2));
