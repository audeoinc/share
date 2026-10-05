const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-079 — long digit runs inside identifiers fold in the fingerprint.
 *
 * Generated SQL from an external scheduler is usually the same statement with a
 * different parameter. When the parameter arrives as a literal, the fingerprint
 * already collapses it (test 046). When it arrives as a DATE SUFFIX ON A TABLE
 * NAME (events_20260101), the tokenizer sees one IDENTIFIER and the fingerprint
 * used to keep every day apart -- 4,814 ephemeral objects for 1,420 distinct
 * statements, and STEP 3 analyzed all of them.
 *
 * fingerprintSqlForBigQuery therefore folds digit runs of at least
 * FINGERPRINT_MIN_IDENTIFIER_DIGIT_RUN (6) digits inside IDENTIFIER and
 * BACKTICK_IDENTIFIER tokens to "#". The floor is what makes this safe: `table_v1`
 * and `table_v2` are two different tables and must stay apart, while a date or an
 * epoch is 6 digits or more. Measured on the real registry, a floor of 6 collapsed
 * exactly as much as a floor of 4.
 */

const fp = bundle.fingerprintSqlForBigQuery;

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_079: " + message);
  }
}

// 1. Date-suffixed table names collapse (backtick-qualified).
assert(
  fp("SELECT a, b FROM `p.d.events_20260101`")
    === fp("SELECT a, b FROM `p.d.events_20260102`"),
  "date-suffixed table names must collapse"
);

// 2. ... and unquoted, where the suffix is part of a bare IDENTIFIER.
assert(
  fp("SELECT a FROM events_20260101")
    === fp("SELECT a FROM events_20260102"),
  "unquoted date-suffixed table names must collapse"
);

// 3. A 6-digit run (YYYYMM) is at the floor and folds.
assert(
  fp("SELECT a FROM `p.d.sales_202601`") === fp("SELECT a FROM `p.d.sales_202602`"),
  "6-digit runs must fold"
);

// 4. A SHORT digit run does NOT fold: these are different tables.
assert(
  fp("SELECT a FROM `p.d.table_v1`") !== fp("SELECT a FROM `p.d.table_v2`"),
  "a one-digit version suffix must stay distinct"
);
assert(
  fp("SELECT a FROM `p.d.t_12345`") !== fp("SELECT a FROM `p.d.t_12346`"),
  "a 5-digit run is below the floor and must stay distinct"
);

// 5. Column and alias names fold the same way.
assert(
  fp("SELECT col_20260101 AS c FROM t") === fp("SELECT col_20260102 AS c FROM t"),
  "date-suffixed column names must collapse"
);

// 6. Structure is still structure: folding digits must not merge different shapes.
assert(
  fp("SELECT a FROM `p.d.events_20260101`")
    !== fp("SELECT a, b FROM `p.d.events_20260102`"),
  "a different select list must still change the fingerprint"
);
assert(
  fp("SELECT a FROM `p.d.events_20260101`")
    !== fp("SELECT a FROM `p.d.orders_20260101`"),
  "a different table stem must still change the fingerprint"
);

// 7. Digits that are NUMBER literals keep collapsing through the literal rule, so a
//    long numeric literal is "?" rather than "#".
assert(
  fp("SELECT a FROM t WHERE n > 20260101") === fp("SELECT a FROM t WHERE n > 1"),
  "numeric literals must still collapse as literals"
);

// 8. Keywords are untouched (no keyword carries a digit run, but the branch must not
//    reach them): a structural keyword difference still separates.
assert(
  fp("SELECT a FROM t WHERE x = 1 AND y = 2")
    !== fp("SELECT a FROM t WHERE x = 1 OR y = 2"),
  "AND vs OR must still change the fingerprint"
);

// 9. Test 046's guarantees are unchanged.
assert(
  fp("SELECT id, name FROM `p.d.t` WHERE dt = '2024-01-01' AND n > 100")
    === fp("select ID, NAME from `p.d.t` where DT = '2024-02-15' and N > 999"),
  "literal-only and case-only differences must still collapse"
);

// 10. Determinism, including repeated folding within one statement (the regex is
//     built per call, so a shared lastIndex cannot make the second call differ).
const repeated = "SELECT a FROM `p.d.events_20260101` JOIN `p.d.other_20260101` USING (a)";
assert(fp(repeated) === fp(repeated), "fingerprint must be deterministic");
assert(
  fp(repeated) === fp("SELECT a FROM `p.d.events_20260509` JOIN `p.d.other_20260510` USING (a)"),
  "every digit run in a statement must fold, not just the first"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_079",
  status: "PASS",
  issue: "Long digit runs inside identifiers fold in the fingerprint; short ones stay distinct"
}));
