const fs = require("fs");
const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));
const {
  UDF_PARAMETER_NAMES,
  UDF_ENTRY_POINT,
  buildPersistentUdfSql
} = require(path.join(__dirname, "../scripts/lib/deployment_udf_sql.js"));

/*
 * v1.5.0-080 — the three deployment paths for the analysis UDF must declare the
 * same signature as the bundle actually exports.
 *
 * The release pipeline's generated DDL had drifted: it declared three parameters
 * and called `LineageEngine.analyzeToJson(...)`, an entry point that exists
 * nowhere in the engine. Setup (01), the redeploy helper and 03's call sites all
 * use the four-parameter `analyzeLineageForBigQuery`. Nothing caught it because
 * the drift is between SQL text and JavaScript, which no test compared: the
 * build reported success and `--deploy` would have replaced a working function
 * with one that fails every call ("No matching signature" from 03, which passes
 * four arguments).
 *
 * So the signature now lives in scripts/lib/deployment_udf_sql.js and this test
 * holds all four readers to it: the bundle's export, the release pipeline's
 * generated DDL, the two hand-written SQL deployments, and 03's call arity.
 */

const repoRoot = path.join(__dirname, "../..");

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_080: " + message);
  }
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

/* Drop -- line comments so a parenthesis inside prose cannot unbalance the scan. */
function stripLineComments(sqlText) {
  return sqlText.replace(/--[^\n]*/g, "");
}

/* Index of the ")" matching the "(" at openIndex, ignoring quoted text. */
function matchingParenIndex(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/*
 * Parameter names of the CREATE FUNCTION whose body calls the entry point.
 * Found from the call backwards, because 01 creates several functions.
 */
function declaredParameterNames(sqlText) {
  const stripped = stripLineComments(sqlText);
  const callIndex = stripped.indexOf(UDF_ENTRY_POINT + "(");
  assert(callIndex !== -1, "no call to " + UDF_ENTRY_POINT + " found");
  const createIndex = stripped.lastIndexOf("CREATE OR REPLACE FUNCTION", callIndex);
  assert(createIndex !== -1, "no CREATE OR REPLACE FUNCTION precedes the call");
  const openIndex = stripped.indexOf("(", createIndex);
  const closeIndex = matchingParenIndex(stripped, openIndex);
  assert(closeIndex !== -1, "unbalanced parameter list");
  return splitTopLevel(stripped.slice(openIndex + 1, closeIndex))
    .map((part) => part.trim().split(/\s+/)[0]);
}

function udfCallArgumentCounts(sqlText) {
  const stripped = stripLineComments(sqlText);
  const marker = "`__UDF__`(";
  const counts = [];
  let index = stripped.indexOf(marker);
  while (index !== -1) {
    const openIndex = index + marker.length - 1;
    const closeIndex = matchingParenIndex(stripped, openIndex);
    assert(closeIndex !== -1, "unbalanced __UDF__ argument list");
    counts.push(splitTopLevel(stripped.slice(openIndex + 1, closeIndex)).length);
    index = stripped.indexOf(marker, closeIndex);
  }
  return counts;
}

const expectedArity = UDF_PARAMETER_NAMES.length;

// 1. The bundle exports the entry point the deployments name, with that arity.
assert(
  typeof bundle[UDF_ENTRY_POINT] === "function",
  "the bundle must export " + UDF_ENTRY_POINT
);
assert(
  bundle[UDF_ENTRY_POINT].length === expectedArity,
  UDF_ENTRY_POINT + " must take " + expectedArity + " arguments, got "
    + bundle[UDF_ENTRY_POINT].length
);

// 2. The release pipeline's generated DDL matches, and names no phantom entry point.
const generated = buildPersistentUdfSql({
  project: "p",
  dataset: "d",
  functionName: "lnge_analyze_json",
  bundleUri: "gs://b/lineage_udf_bundle.js"
});
assert(
  declaredParameterNames(generated).join(",") === UDF_PARAMETER_NAMES.join(","),
  "generated DDL parameters must be " + UDF_PARAMETER_NAMES.join(",")
);
assert(
  generated.includes("return " + UDF_ENTRY_POINT + "("),
  "generated DDL must call " + UDF_ENTRY_POINT
);
assert(
  !generated.includes("analyzeToJson"),
  "generated DDL must not call analyzeToJson, which the engine does not export"
);
assert(
  generated.includes('OPTIONS (library=["gs://b/lineage_udf_bundle.js"])'),
  "generated DDL must load the bundle it was given"
);

// 3. Both hand-written SQL deployments declare the same parameters.
const sqlDeployments = [
  "sql/setup/01_setup_lineage_environment.sql",
  "sql/bigquery/create_persistent_lineage_udf.sql"
];
sqlDeployments.forEach((relativePath) => {
  const declared = declaredParameterNames(readRepoFile(relativePath));
  assert(
    declared.join(",") === UDF_PARAMETER_NAMES.join(","),
    relativePath + " declares [" + declared.join(",") + "], expected ["
      + UDF_PARAMETER_NAMES.join(",") + "]"
  );
});

// 4. Every call site in 03 passes exactly that many arguments. This is the side
//    that breaks first: a short deployment fails here with "No matching signature".
const pipelineCounts = udfCallArgumentCounts(
  readRepoFile("sql/pipeline/03_run_daily_lineage_pipeline.sql")
);
assert(pipelineCounts.length > 0, "03 must contain __UDF__ call sites");
pipelineCounts.forEach((count, position) => {
  assert(
    count === expectedArity,
    "03 __UDF__ call site " + (position + 1) + " passes " + count
      + " arguments, expected " + expectedArity
  );
});

// 5. The entry point is reachable as a bare global inside the UDF body, which is
//    how the DDL calls it -- not only through module.exports.
const bundleSource = fs.readFileSync(
  path.join(__dirname, "../dist/lineage_udf_bundle.js"),
  "utf8"
);
assert(
  new RegExp("function\\s+" + UDF_ENTRY_POINT + "\\s*\\(").test(bundleSource),
  UDF_ENTRY_POINT + " must be a top-level function declaration in the bundle"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_080",
  status: "PASS",
  issue: "All three UDF deployment paths and 03's call sites match the bundle's "
    + UDF_ENTRY_POINT + "/" + expectedArity + " signature",
  pipeline_call_sites: pipelineCounts.length
}));
