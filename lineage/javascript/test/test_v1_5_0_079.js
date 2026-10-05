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
 * FINGERPRINT_MIN_IDENTIFIER_DIGIT_RUN (6) digits inside IDENTIFIER and
 * BACKTICK_IDENTIFIER tokens to "#".
 *
 * The floor is measured, and the test that set it is RECURRENCE, not length: a value
 * that is minted per run appears on exactly one day, while a value that identifies a
 * real thing comes back every day. Over eight days of job history, every distinct
 * 6, 8, 18, 19 and 20-digit run appeared on exactly one day (3,026 distinct 6-digit
 * values, 100% one-day), while the 1, 2 and 9-digit runs appeared on 7-8 days each.
 * So 6 is where throwaway ids begin. A length census alone had suggested 10 and was
 * wrong: 6-digit values look exactly like product codes until you ask whether they
 * ever come back.
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
  "a 10-digit id must fold"
);

// 3. A 6-digit run is AT the floor and folds: this is the per-run id that was
//    registering a new ephemeral object every day.
assert(
  fp("SELECT a FROM `p.d.tmp_123456`") === fp("SELECT a FROM `p.d.tmp_654321`"),
  "a 6-digit run id must fold"
);

// 4. Runs below the floor stay distinct: these name different things, and the
//    recurrence census found them coming back day after day.
assert(
  fp("SELECT a FROM `p.d.table_v1`") !== fp("SELECT a FROM `p.d.table_v2`"),
  "a one-digit version suffix must stay distinct"
);
assert(
  fp("SELECT a FROM `p.d.table_12`") !== fp("SELECT a FROM `p.d.table_34`"),
  "a two-digit suffix must stay distinct"
);
assert(
  fp("SELECT a FROM `p.d.t_12345`") !== fp("SELECT a FROM `p.d.t_54321`"),
  "a 5-digit run is below the floor and must stay distinct"
);

// 5. An 8-digit date suffix folds too -- at this floor it is indistinguishable from
//    any other throwaway run id, and the census found those values non-recurring.
assert(
  fp("SELECT a FROM `p.d.events_20260101`") === fp("SELECT a FROM `p.d.events_20260102`"),
  "an 8-digit date suffix must fold"
);

// 6. Column and alias names fold by the same rule.
assert(
  fp("SELECT col_12345678901 AS c FROM t") === fp("SELECT col_10987654321 AS c FROM t"),
  "a long id in a column name must fold"
);

// 7. Structure is still structure: folding must not merge different shapes.
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

// 8. Digits that are NUMBER literals keep collapsing through the literal rule, so a
//    long numeric literal is "?" rather than "#".
assert(
  fp("SELECT a FROM t WHERE n > 12345678901234567890")
    === fp("SELECT a FROM t WHERE n > 1"),
  "numeric literals must still collapse as literals"
);

// 9. Keywords are untouched: a structural keyword difference still separates.
assert(
  fp("SELECT a FROM t WHERE x = 1 AND y = 2")
    !== fp("SELECT a FROM t WHERE x = 1 OR y = 2"),
  "AND vs OR must still change the fingerprint"
);

// 10. Test 046's guarantees are unchanged.
assert(
  fp("SELECT id, name FROM `p.d.t` WHERE dt = '2024-01-01' AND n > 100")
    === fp("select ID, NAME from `p.d.t` where DT = '2024-02-15' and N > 999"),
  "literal-only and case-only differences must still collapse"
);

// 11. Determinism, including repeated folding within one statement (the regex is
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
  issue: "Digit runs of 6+ inside identifiers fold in the fingerprint; shorter ones stay distinct"
}));
