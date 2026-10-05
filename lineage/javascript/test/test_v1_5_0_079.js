const path = require("path");
const bundle = require(path.join(__dirname, "../dist/lineage_udf_bundle.js"));

/*
 * v1.5.0-079 — long digit runs inside identifiers fold in the fingerprint.
 *
 * Generated SQL from an external scheduler is usually the same statement run again.
 * When what varies arrives as a literal, the fingerprint already collapses it
 * (test 046). When it arrives inside an IDENTIFIER -- a temp table whose name carries
 * a sequence number or a timestamp -- the tokenizer sees one token and the
 * fingerprint used to keep every run apart, registering a new ephemeral object each
 * time.
 *
 * fingerprintSqlForBigQuery therefore folds digit runs of at least
 * FINGERPRINT_MIN_IDENTIFIER_DIGIT_RUN (10) digits inside IDENTIFIER and
 * BACKTICK_IDENTIFIER tokens to "#". The floor is measured, not guessed: a census of
 * the digit runs inside identifiers in the real registry found 20-digit runs with
 * 1,783 distinct values in 2,047 occurrences (per-object ids -- fold), against 6-digit
 * runs with 1,507 distinct values that are NOT century-dated (product codes and the
 * like -- must stay apart) and 9-digit runs with only 7 distinct values (not rotating,
 * nothing to gain). 10 folds the first group and only the first group.
 */

const fp = bundle.fingerprintSqlForBigQuery;

function assert(condition, message) {
  if (!condition) {
    throw new Error("test_v1_5_0_079: " + message);
  }
}

// 1. A long machine-generated id in a table name folds.
assert(
  fp("SELECT a, b FROM `p.d.tmp_01234567890123456789`")
    === fp("SELECT a, b FROM `p.d.tmp_98765432109876543210`"),
  "a 20-digit id in a table name must fold"
);

// 2. ... and unquoted, where the id is part of a bare IDENTIFIER.
assert(
  fp("SELECT a FROM tmp_1234567890") === fp("SELECT a FROM tmp_9999999999"),
  "a 10-digit id is at the floor and must fold"
);

// 3. A 9-digit run is below the floor and stays distinct.
assert(
  fp("SELECT a FROM `p.d.t_123456789`") !== fp("SELECT a FROM `p.d.t_987654321`"),
  "a 9-digit run is below the floor and must stay distinct"
);

// 4. Short runs stay distinct: these name different things.
assert(
  fp("SELECT a FROM `p.d.table_v1`") !== fp("SELECT a FROM `p.d.table_v2`"),
  "a one-digit version suffix must stay distinct"
);
assert(
  fp("SELECT a FROM `p.d.item_123456`") !== fp("SELECT a FROM `p.d.item_654321`"),
  "a 6-digit code must stay distinct"
);
assert(
  fp("SELECT a FROM `p.d.events_20260101`") !== fp("SELECT a FROM `p.d.events_20260102`"),
  "an 8-digit date is below the floor and must stay distinct"
);

// 5. Column and alias names fold by the same rule.
assert(
  fp("SELECT col_12345678901 AS c FROM t") === fp("SELECT col_10987654321 AS c FROM t"),
  "a long id in a column name must fold"
);

// 6. Structure is still structure: folding must not merge different shapes.
assert(
  fp("SELECT a FROM `p.d.tmp_01234567890123456789`")
    !== fp("SELECT a, b FROM `p.d.tmp_98765432109876543210`"),
  "a different select list must still change the fingerprint"
);
assert(
  fp("SELECT a FROM `p.d.tmp_01234567890123456789`")
    !== fp("SELECT a FROM `p.d.stg_98765432109876543210`"),
  "a different table stem must still change the fingerprint"
);

// 7. Digits that are NUMBER literals keep collapsing through the literal rule, so a
//    long numeric literal is "?" rather than "#".
assert(
  fp("SELECT a FROM t WHERE n > 12345678901234567890")
    === fp("SELECT a FROM t WHERE n > 1"),
  "numeric literals must still collapse as literals"
);

// 8. Keywords are untouched: a structural keyword difference still separates.
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
const repeated =
  "SELECT a FROM `p.d.tmp_01234567890123456789` JOIN `p.d.stg_01234567890123456789` USING (a)";
assert(fp(repeated) === fp(repeated), "fingerprint must be deterministic");
assert(
  fp(repeated)
    === fp("SELECT a FROM `p.d.tmp_55555555555555555555` JOIN `p.d.stg_66666666666666666666` USING (a)"),
  "every digit run in a statement must fold, not just the first"
);

console.log(JSON.stringify({
  test: "test_v1_5_0_079",
  status: "PASS",
  issue: "Digit runs of 10+ inside identifiers fold in the fingerprint; shorter ones stay distinct"
}));
