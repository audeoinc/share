#!/usr/bin/env python3
"""BigQuery コスト集計で使う SQL 正規化の RE2 リファレンス実装 + 自己テスト。

BigQuery の REGEXP_REPLACE は RE2 エンジンを使うので、ここで google-re2 を
使って同じパターンを検証しておけば、BigQuery 側での挙動もほぼ同じになる。
pipeline/01 の `bqc_normalize_sql` UDF はこのリストと 1:1 で対応させること。
どちらかを直したら両方直す。

  python3 tools/normalize_reference.py           # 自己テスト
  python3 tools/normalize_reference.py -         # 標準入力の SQL を正規化して表示
"""
import sys

import re2

# ---------------------------------------------------------------------------
# 正規化ステップ。(名前, パターン, 置換) の適用順がそのまま意味を持つ。
# BigQuery 側は同じ順序で REGEXP_REPLACE をネストする。
# ---------------------------------------------------------------------------
STEPS = [
    # 1. コメント除去。文字列より先に落とす（コメント中のアポストロフィのほうが
    #    文字列中の -- より圧倒的に多いため。詳細は README の「既知の限界」）。
    ("block_comment",   r"(?s)/\*.*?\*/",                          " "),
    ("line_comment",    r"--[^\n]*",                               " "),
    ("hash_comment",    r"#[^\n]*",                                " "),

    # 2. 文字列リテラル。三重引用符を先に潰さないと単一引用符処理で崩れる。
    #    RE2 は後方参照が無いので開始/終了の対応は取れず、種類ごとに列挙する。
    #    クォート文字は必ず [ ] で囲むこと。BigQuery 側は UDF 本体を生文字列
    #    r"""...""" に埋め込むので、パターン中にクォート3連が素で現れると
    #    そこで文字列が終端してしまう。["]["]["] なら同じ RE2 パターンのまま防げる。
    ("triple_dq",       r'(?s)[rRbB]{0,2}["]["]["].*?["]["]["]',    "?"),
    ("triple_sq",       r"(?s)[rRbB]{0,2}['][']['].*?[']['][']",    "?"),
    ("single_dq",       r'[rRbB]{0,2}["](?:[^"\\]|\\.)*["]',        "?"),
    ("single_sq",       r"[rRbB]{0,2}['](?:[^'\\]|\\.)*[']",        "?"),

    # 3. バッククォート識別子はクォートだけ外して中身を残す（テーブル名は
    #    fingerprint の識別力そのものなので消さない。README の A-3 参照）。
    ("backtick",        r"`([^`]*)`",                              r"\1"),

    # 4. 日付サフィックスの畳み込み。GA4 の events_YYYYMMDD /
    #    events_intraday_YYYYMMDD や _YYYYMM 分割テーブルが日ごとに別
    #    fingerprint に割れるのを防ぐ。8桁を先に処理する。
    ("date_suffix_8",   r"_[0-9]{8}\b",                            "_?"),
    ("date_suffix_6",   r"_[0-9]{6}\b",                            "_?"),

    # 5. 数値リテラル。RE2 には後読みが無いので直前の 1 文字を捕獲して書き戻す。
    #    直前が識別子文字なら対象外＝col1 / t1.x / events_? を壊さない。
    ("hex_number",      r"([^A-Za-z0-9_.$])0[xX][0-9A-Fa-f]+",     r"\1?"),
    ("number",
     r"([^A-Za-z0-9_.$])[-+]?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?",
     r"\1?"),

    # 6. 連続プレースホルダの畳み込み。IN (?,?,?) の要素数違いで
    #    fingerprint が割れるのを防ぐ。
    ("collapse_list",   r"\?(?:\s*,\s*\?)+",                       "?"),

    # 7. 空白の正規化。
    ("whitespace",      r"\s+",                                    " "),
]

COMPILED = [(name, re2.compile(pat), rep) for name, pat, rep in STEPS]


def normalize(sql: str) -> str:
    """SQL からリテラル・コメントを除去した正規化文字列を返す（大小文字は保持）。"""
    out = sql
    for _name, pattern, replacement in COMPILED:
        out = pattern.sub(replacement, out)
    return out.strip()


def fingerprint_input(sql: str) -> str:
    """fingerprint に食わせる文字列。識別子の大小文字差を吸収する。"""
    return normalize(sql).upper()


# ---------------------------------------------------------------------------
# 自己テスト。(説明, 入力SQL, 期待する正規化結果)
# ---------------------------------------------------------------------------
CASES = [
    (
        "文字列リテラルが ? になる",
        "SELECT * FROM t WHERE name = 'yamada taro'",
        "SELECT * FROM t WHERE name = ?",
    ),
    (
        "数値リテラルが ? になる",
        "SELECT * FROM t WHERE amount >= 100000",
        "SELECT * FROM t WHERE amount >= ?",
    ),
    (
        "識別子に含まれる数字は壊さない",
        "SELECT t1.col1, t1.col2 FROM ds.table_2024 AS t1",
        "SELECT t1.col1, t1.col2 FROM ds.table_2024 AS t1",
    ),
    (
        "IN リストは要素数に関わらず同一になる (A)",
        "SELECT * FROM t WHERE id IN (1, 2, 3)",
        "SELECT * FROM t WHERE id IN (?)",
    ),
    (
        "IN リストは要素数に関わらず同一になる (B)",
        "SELECT * FROM t WHERE id IN (10, 20, 30, 40, 50)",
        "SELECT * FROM t WHERE id IN (?)",
    ),
    (
        "行コメントは除去される（BIツールの注入コメント対策）",
        "-- Looker Query Context '{\"user_id\":42}'\nSELECT 1 FROM t",
        "SELECT ? FROM t",
    ),
    (
        "ブロックコメントは除去される",
        "SELECT /* request_id=abc-123 */ x FROM t",
        "SELECT x FROM t",
    ),
    (
        "# コメントは除去される",
        "SELECT x FROM t # trailing note\n",
        "SELECT x FROM t",
    ),
    (
        "コメント中のアポストロフィで壊れない",
        "-- don't scan the whole table\nSELECT x FROM t WHERE d = '2026-01-01'",
        "SELECT x FROM t WHERE d = ?",
    ),
    (
        "バッククォートは外して中身を残す",
        "SELECT x FROM `proj-a.ds.orders`",
        "SELECT x FROM proj-a.ds.orders",
    ),
    (
        "別テーブルは別の正規化結果になる（識別力の維持）",
        "SELECT x FROM `proj.ds.tiny_master`",
        "SELECT x FROM proj.ds.tiny_master",
    ),
    (
        "GA4 の日次シャードは畳み込まれるが property id は残る",
        "SELECT event_name FROM `proj.analytics_123456789.events_20260101`",
        "SELECT event_name FROM proj.analytics_123456789.events_?",
    ),
    (
        "GA4 の intraday も畳み込まれる",
        "SELECT event_name FROM `proj.ds.events_intraday_20260908`",
        "SELECT event_name FROM proj.ds.events_intraday_?",
    ),
    (
        "月次シャードも畳み込まれる",
        "SELECT x FROM `proj.ds.log_202609`",
        "SELECT x FROM proj.ds.log_?",
    ),
    (
        "_TABLE_SUFFIX の範囲指定は文字列側で ? になる",
        "SELECT x FROM `proj.ds.events_*` "
        "WHERE _TABLE_SUFFIX BETWEEN '20260101' AND '20260131'",
        "SELECT x FROM proj.ds.events_* WHERE _TABLE_SUFFIX BETWEEN ? AND ?",
    ),
    (
        "三重引用符文字列",
        'SELECT REGEXP_CONTAINS(x, r"""a\'b""") FROM t',
        "SELECT REGEXP_CONTAINS(x, ?) FROM t",
    ),
    (
        "raw 文字列のプレフィックスも一緒に消える",
        "SELECT REGEXP_EXTRACT(x, r'^([^-]+)') FROM t",
        "SELECT REGEXP_EXTRACT(x, ?) FROM t",
    ),
    (
        "エスケープされた引用符を含む文字列",
        "SELECT * FROM t WHERE s = 'it\\'s fine' AND n = 5",
        "SELECT * FROM t WHERE s = ? AND n = ?",
    ),
    (
        "浮動小数・指数・負数",
        "SELECT * FROM t WHERE r > 0.5 AND e < 1.2e-3 AND n = -7",
        "SELECT * FROM t WHERE r > ? AND e < ? AND n = ?",
    ),
    (
        "16進リテラル",
        "SELECT * FROM t WHERE b = 0xFF",
        "SELECT * FROM t WHERE b = ?",
    ),
    (
        "型付きリテラルは DATE ? に畳まれる",
        "SELECT * FROM t WHERE d = DATE '2026-01-01'",
        "SELECT * FROM t WHERE d = DATE ?",
    ),
    (
        "名前付きクエリパラメータは温存される",
        "SELECT * FROM t WHERE d = @run_date",
        "SELECT * FROM t WHERE d = @run_date",
    ),
    (
        "改行・インデントの差は吸収される",
        "SELECT\n    a,\n    b\nFROM   t",
        "SELECT a, b FROM t",
    ),
]

FINGERPRINT_EQUAL_CASES = [
    (
        "リテラル違いは同一 fingerprint",
        "SELECT SUM(v) FROM `p.d.t` WHERE dt = '2026-01-01'",
        "SELECT SUM(v) FROM `p.d.t` WHERE dt = '2026-09-08'",
    ),
    (
        "大小文字違いは同一 fingerprint",
        "select sum(v) from `p.d.t` where dt = '2026-01-01'",
        "SELECT SUM(v) FROM `p.d.t` WHERE dt = '2026-01-01'",
    ),
    (
        "GA4 の別日シャードは同一 fingerprint",
        "SELECT COUNT(*) FROM `p.a_1.events_20260101`",
        "SELECT COUNT(*) FROM `p.a_1.events_20260908`",
    ),
    (
        "注入コメント違いは同一 fingerprint",
        "-- ctx: run=1\nSELECT COUNT(*) FROM `p.d.t`",
        "-- ctx: run=99999\nSELECT COUNT(*) FROM `p.d.t`",
    ),
]

FINGERPRINT_DIFFER_CASES = [
    (
        "参照テーブルが違えば別 fingerprint",
        "SELECT COUNT(*) FROM `p.d.orders_big`",
        "SELECT COUNT(*) FROM `p.d.tiny_master`",
    ),
    (
        "句が増えれば別 fingerprint",
        "SELECT COUNT(*) FROM `p.d.t`",
        "SELECT COUNT(*) FROM `p.d.t` GROUP BY x",
    ),
]


def _run_tests() -> int:
    failures = 0

    for label, sql, expected in CASES:
        actual = normalize(sql)
        if actual != expected:
            failures += 1
            print(f"FAIL  {label}")
            print(f"        input    : {sql!r}")
            print(f"        expected : {expected!r}")
            print(f"        actual   : {actual!r}")
        else:
            print(f"ok    {label}")

    for label, left, right in FINGERPRINT_EQUAL_CASES:
        if fingerprint_input(left) != fingerprint_input(right):
            failures += 1
            print(f"FAIL  {label}")
            print(f"        left  : {fingerprint_input(left)!r}")
            print(f"        right : {fingerprint_input(right)!r}")
        else:
            print(f"ok    {label}")

    for label, left, right in FINGERPRINT_DIFFER_CASES:
        if fingerprint_input(left) == fingerprint_input(right):
            failures += 1
            print(f"FAIL  {label}  (同一になってしまった)")
            print(f"        both : {fingerprint_input(left)!r}")
        else:
            print(f"ok    {label}")

    total = len(CASES) + len(FINGERPRINT_EQUAL_CASES) + len(FINGERPRINT_DIFFER_CASES)
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "-":
        print(normalize(sys.stdin.read()))
    else:
        sys.exit(_run_tests())
