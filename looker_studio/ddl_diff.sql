-- =====================================================================
-- BigQuery View DDL の差分を Looker Studio 上で GitHub compare 風に表示する
--
-- 差分計算は Looker Studio 側ではできない（配列 / ループ / 行分割がない）ため、
-- すべて BigQuery 側で「行単位の差分テーブル」を作り、
-- Looker Studio は表グラフ + 条件付き書式で色を塗るだけ、という構成にする。
--
-- 実行順:
--   0. (任意) DDL スナップショットを日次で貯める
--   1. DIFF_LINES UDF を作る
--   2. v_view_ddl_diff_split  … 左右2ペイン (GitHub の Split view)
--      v_view_ddl_diff_unified … 1カラム (GitHub の Unified view)
--      v_view_ddl_diff_summary … +N / -M のサマリ
--   3. 実運用ではスケジュールドクエリで TABLE に materialize する（末尾参照）
--
-- PROJECT / DATASET はすべて自分の環境に置換すること。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. DDL スナップショット（すでに2つのデータを持っているなら不要）
--    INFORMATION_SCHEMA.TABLES.ddl に CREATE VIEW 文がそのまま入っている。
-- ---------------------------------------------------------------------
-- CREATE TABLE IF NOT EXISTS `PROJECT.DATASET.view_ddl_snapshot`
-- (
--   snapshot_date DATE,
--   table_catalog STRING,
--   table_schema  STRING,
--   table_name    STRING,
--   ddl           STRING
-- )
-- PARTITION BY snapshot_date;
--
-- INSERT INTO `PROJECT.DATASET.view_ddl_snapshot`
-- SELECT
--   CURRENT_DATE('Asia/Tokyo') AS snapshot_date,
--   table_catalog, table_schema, table_name, ddl
-- FROM `PROJECT.TARGET_DATASET.INFORMATION_SCHEMA.TABLES`
-- WHERE table_type = 'VIEW';


-- ---------------------------------------------------------------------
-- 1. 行単位 diff UDF（LCS / git diff と同じ考え方）
--
--    戻り値 1 行 = 表示上の 1 行。
--      op = '='  変更なし
--           '~'  変更（左右が対応する）
--           '-'  削除のみ
--           '+'  追加のみ
--           '!'  行数が多すぎてスキップ
--
--    ※ 行番号を FLOAT64 で返しているのは、JavaScript UDF の入出力型として
--       INT64 が使えないため。呼び出し側の VIEW で INT64 に CAST する。
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION `PROJECT.DATASET.DIFF_LINES`(
  before_ddl STRING,
  after_ddl  STRING,
  ignore_ws  BOOL
)
RETURNS ARRAY<STRUCT<
  seq        FLOAT64,
  op         STRING,
  left_no    FLOAT64,
  left_text  STRING,
  right_no   FLOAT64,
  right_text STRING
>>
LANGUAGE js AS r"""
  var MAX_CELLS = 4000000;  // 約 2000 行 x 2000 行。UDF のメモリ上限対策。

  function prep(s) {
    var t = (s === null || s === undefined) ? "" : String(s);
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
    var arr = t.split("\n");
    while (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
    return arr;
  }
  function key(s) {
    return ignore_ws ? s.replace(/\s+/g, " ").trim() : s;
  }

  var A = prep(before_ddl), B = prep(after_ddl);
  var n = A.length, m = B.length;

  if ((n + 1) * (m + 1) > MAX_CELLS) {
    return [{ seq: 1, op: "!", left_no: null,
              left_text: "-- diff skipped: too many lines (" + n + " x " + m + ")",
              right_no: null, right_text: null }];
  }

  var KA = new Array(n), KB = new Array(m);
  for (var x = 0; x < n; x++) KA[x] = key(A[x]);
  for (var y = 0; y < m; y++) KB[y] = key(B[y]);

  // LCS の長さ表を右下から埋める
  var W = m + 1;
  var dp = new Int32Array((n + 1) * W);
  for (var i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      dp[i * W + j] = (KA[i] === KB[j])
        ? dp[(i + 1) * W + (j + 1)] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
    }
  }

  // 表をたどって unified な操作列にする
  var ops = [];
  var p = 0, q = 0;
  while (p < n && q < m) {
    if (KA[p] === KB[q]) { ops.push({ op: "=", l: p, r: q }); p++; q++; }
    else if (dp[(p + 1) * W + q] >= dp[p * W + (q + 1)]) { ops.push({ op: "-", l: p, r: -1 }); p++; }
    else { ops.push({ op: "+", l: -1, r: q }); q++; }
  }
  while (p < n) { ops.push({ op: "-", l: p, r: -1 }); p++; }
  while (q < m) { ops.push({ op: "+", l: -1, r: q }); q++; }

  // 削除ブロックと追加ブロックを左右に対応付ける（GitHub の Split view）
  var rows = [];
  var k = 0, seq = 0;
  while (k < ops.length) {
    if (ops[k].op === "=") {
      seq++;
      rows.push({ seq: seq, op: "=",
                  left_no: ops[k].l + 1, left_text: A[ops[k].l],
                  right_no: ops[k].r + 1, right_text: B[ops[k].r] });
      k++;
      continue;
    }
    var dels = [], adds = [];
    while (k < ops.length && ops[k].op !== "=") {
      if (ops[k].op === "-") dels.push(ops[k].l); else adds.push(ops[k].r);
      k++;
    }
    var len = Math.max(dels.length, adds.length);
    for (var t = 0; t < len; t++) {
      var dl = t < dels.length ? dels[t] : null;
      var ar = t < adds.length ? adds[t] : null;
      seq++;
      rows.push({
        seq: seq,
        op: (dl !== null && ar !== null) ? "~" : (dl !== null ? "-" : "+"),
        left_no:    dl !== null ? dl + 1 : null,
        left_text:  dl !== null ? A[dl]  : null,
        right_no:   ar !== null ? ar + 1 : null,
        right_text: ar !== null ? B[ar]  : null
      });
    }
  }
  return rows;
""";


-- ---------------------------------------------------------------------
-- 2-1. Split view（左=旧 / 右=新）
--
--  ・先頭のインデントは NBSP (CHR(160)) に置換する。
--    Looker Studio の表は連続する半角スペースを潰すため、そのままだと
--    インデントが崩れて diff が読めなくなる。
--  ・near_change_3 は「変更行の前後3行」フラグ。GitHub のように
--    変更箇所だけ表示したいときに Looker Studio 側でフィルタする。
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW `PROJECT.DATASET.v_view_ddl_diff_split` AS
WITH
-- ↓↓↓ ここを自分の「2つのデータ」に差し替える ↓↓↓
before_side AS (
  SELECT
    FORMAT('%s.%s.%s', table_catalog, table_schema, table_name) AS view_key,
    ddl
  FROM `PROJECT.DATASET.view_ddl_snapshot`
  WHERE snapshot_date = DATE '2026-08-01'
),
after_side AS (
  SELECT
    FORMAT('%s.%s.%s', table_catalog, table_schema, table_name) AS view_key,
    ddl
  FROM `PROJECT.DATASET.view_ddl_snapshot`
  WHERE snapshot_date = DATE '2026-08-17'
),
-- ↑↑↑ ここまで ↑↑↑
pair AS (
  SELECT
    COALESCE(b.view_key, a.view_key) AS view_key,
    b.ddl AS before_ddl,
    a.ddl AS after_ddl
  FROM before_side b
  FULL OUTER JOIN after_side a USING (view_key)
),
diffed AS (
  SELECT
    p.view_key,
    CAST(d.seq AS INT64)      AS seq,
    d.op,
    CAST(d.left_no AS INT64)  AS left_no,
    d.left_text,
    CAST(d.right_no AS INT64) AS right_no,
    d.right_text
  FROM pair p,
  UNNEST(`PROJECT.DATASET.DIFF_LINES`(p.before_ddl, p.after_ddl, FALSE)) AS d
)
SELECT
  view_key,
  seq,
  op,
  CASE op WHEN '-' THEN '−' WHEN '+' THEN '+' WHEN '~' THEN '±' ELSE '' END AS mark,
  left_no,
  right_no,
  -- 表示用（インデント保持）
  IFNULL(CONCAT(REPEAT(CHR(160), LENGTH(left_text)  - LENGTH(LTRIM(left_text,  ' '))), LTRIM(left_text,  ' ')), '') AS left_line,
  IFNULL(CONCAT(REPEAT(CHR(160), LENGTH(right_text) - LENGTH(LTRIM(right_text, ' '))), LTRIM(right_text, ' ')), '') AS right_line,
  -- 生データ（検索・エクスポート用）
  left_text,
  right_text,
  COUNTIF(op <> '=') OVER (
    PARTITION BY view_key ORDER BY seq ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING
  ) > 0 AS near_change_3,
  COUNTIF(op <> '=') OVER (PARTITION BY view_key) AS view_change_count
FROM diffed;


-- ---------------------------------------------------------------------
-- 2-2. Unified view（1カラム。GitHub の Unified 表示相当）
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW `PROJECT.DATASET.v_view_ddl_diff_unified` AS
SELECT
  view_key,
  seq * 10 + u.ord AS seq,
  u.mark,
  u.lineno,
  CONCAT(u.mark, CHR(160), u.line) AS line,
  near_change_3,
  view_change_count
FROM `PROJECT.DATASET.v_view_ddl_diff_split`,
UNNEST(
  CASE op
    WHEN '=' THEN [STRUCT(' ' AS mark, left_no  AS lineno, left_line  AS line, 0 AS ord)]
    WHEN '-' THEN [STRUCT('-' AS mark, left_no  AS lineno, left_line  AS line, 0 AS ord)]
    WHEN '+' THEN [STRUCT('+' AS mark, right_no AS lineno, right_line AS line, 0 AS ord)]
    WHEN '~' THEN [STRUCT('-' AS mark, left_no  AS lineno, left_line  AS line, 0 AS ord),
                   STRUCT('+' AS mark, right_no AS lineno, right_line AS line, 1 AS ord)]
    ELSE          [STRUCT('!' AS mark, left_no  AS lineno, left_line  AS line, 0 AS ord)]
  END
) AS u;


-- ---------------------------------------------------------------------
-- 2-3. サマリ（スコアカード / 一覧表用）
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW `PROJECT.DATASET.v_view_ddl_diff_summary` AS
SELECT
  view_key,
  COUNTIF(op IN ('+', '~')) AS added_lines,
  COUNTIF(op IN ('-', '~')) AS deleted_lines,
  COUNTIF(op = '=')         AS unchanged_lines,
  COUNTIF(op <> '=') > 0    AS has_change,
  CONCAT('+', CAST(COUNTIF(op IN ('+','~')) AS STRING),
         ' / −', CAST(COUNTIF(op IN ('-','~')) AS STRING)) AS change_label
FROM `PROJECT.DATASET.v_view_ddl_diff_split`
GROUP BY view_key;


-- ---------------------------------------------------------------------
-- 3. 実運用: VIEW のままだと Looker Studio の操作のたびに UDF が
--    走って重いので、スケジュールドクエリでテーブル化して
--    Looker Studio はそのテーブルを見る、を推奨。
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE TABLE `PROJECT.DATASET.view_ddl_diff` AS
-- SELECT * FROM `PROJECT.DATASET.v_view_ddl_diff_split`;
