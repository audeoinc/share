"use strict";

/*
 * Single source of truth for the persistent analysis UDF's signature.
 *
 * Three places create this function and they must agree, because 03 calls it
 * with four arguments:
 *   - sql/setup/01_setup_lineage_environment.sql        (initial setup)
 *   - sql/bigquery/create_persistent_lineage_udf.sql    (redeploy helper)
 *   - scripts/build_everything.js --deploy              (release pipeline)
 * A deployment that declares fewer parameters, or calls an entry point the
 * bundle does not export, makes every analysis fail at runtime ("No matching
 * signature" / "not defined"), while the build itself still reports success.
 * test/test_v1_5_0_080.js cross-checks all three against the built bundle.
 */

const UDF_PARAMETER_NAMES = [
  "sql_text",
  "physical_columns_json",
  "options_json",
  "export_metadata_json"
];

const UDF_ENTRY_POINT = "analyzeLineageForBigQuery";

function buildPersistentUdfSql(options) {
  const project = options.project;
  const dataset = options.dataset;
  const functionName = options.functionName;
  const bundleUri = options.bundleUri;
  const parameterList = UDF_PARAMETER_NAMES
    .map((name) => `  ${name} STRING`)
    .join(",\n");
  const argumentList = UDF_PARAMETER_NAMES
    .map((name) => `    ${name}`)
    .join(",\n");
  return [
    `CREATE OR REPLACE FUNCTION \`${project}.${dataset}.${functionName}\`(`,
    parameterList,
    ")",
    "RETURNS STRING",
    "LANGUAGE js",
    `OPTIONS (library=["${bundleUri}"])`,
    'AS r"""',
    `  return ${UDF_ENTRY_POINT}(`,
    argumentList,
    "  );",
    '""";'
  ].join("\n");
}

module.exports = {
  UDF_PARAMETER_NAMES,
  UDF_ENTRY_POINT,
  buildPersistentUdfSql
};
