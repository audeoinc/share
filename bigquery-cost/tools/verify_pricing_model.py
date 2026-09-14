#!/usr/bin/env python3
"""pricing_model / not_billed_reason の分類ロジックを再現して検証する。

pipeline/02 の CASE 式と 1:1 で対応。どちらかを直したら両方直すこと。

  python3 tools/verify_pricing_model.py
"""
import re
import sys

METADATA_PREFIX = re.compile(
    r"^(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|SET|DECLARE|CALL|ASSERT|EXPORT|LOAD)")


def classify(reservation_id, total_bytes_billed, error_result, cache_hit, statement_type):
    """pipeline/02 の CASE 式をそのまま再現する。"""
    billed = total_bytes_billed or 0

    if reservation_id is not None:
        pricing_model = "CAPACITY"
    elif billed > 0:
        pricing_model = "ON_DEMAND"
    else:
        pricing_model = "NOT_BILLED"

    if reservation_id is not None or billed > 0:
        reason = None
    elif error_result is not None:
        reason = "ERROR"
    elif cache_hit:
        reason = "CACHE_HIT"
    elif METADATA_PREFIX.match(statement_type or ""):
        reason = "METADATA_ONLY"
    else:
        reason = "NO_DATA_SCANNED"

    return pricing_model, reason


CASES = [
    # (説明, reservation_id, bytes_billed, error, cache_hit, statement_type, 期待)
    ("通常のオンデマンドクエリ",
     None, 10 * 1024**2, None, False, "SELECT", ("ON_DEMAND", None)),
    ("予約ありのクエリ",
     "res-1", 10 * 1024**2, None, False, "SELECT", ("CAPACITY", None)),
    ("予約あり・バイト0でもキャパシティ（予約の上で走っている）",
     "res-1", 0, None, False, "SELECT", ("CAPACITY", None)),
    ("失敗したクエリは課金されない",
     None, 0, "resourcesExceeded", False, "SELECT", ("NOT_BILLED", "ERROR")),
    ("失敗が最優先（キャッシュフラグより前）",
     None, 0, "invalidQuery", True, "SELECT", ("NOT_BILLED", "ERROR")),
    ("キャッシュヒットは課金されない",
     None, 0, None, True, "SELECT", ("NOT_BILLED", "CACHE_HIT")),
    ("データを伴わない CREATE",
     None, 0, None, False, "CREATE_VIEW", ("NOT_BILLED", "METADATA_ONLY")),
    ("ALTER も同様",
     None, 0, None, False, "ALTER_TABLE", ("NOT_BILLED", "METADATA_ONLY")),
    ("DROP も同様",
     None, 0, None, False, "DROP_TABLE", ("NOT_BILLED", "METADATA_ONLY")),
    ("データを伴う CTAS はバイトが出るのでオンデマンド",
     None, 5 * 1024**3, None, False, "CREATE_TABLE_AS_SELECT", ("ON_DEMAND", None)),
    ("0バイトのクエリ（SELECT 1 など）",
     None, 0, None, False, "SELECT", ("NOT_BILLED", "NO_DATA_SCANNED")),
    ("statement_type が NULL でも落ちない",
     None, 0, None, False, None, ("NOT_BILLED", "NO_DATA_SCANNED")),
    ("バイトが NULL の種別（LOAD など）は無料扱い",
     None, None, None, False, "LOAD_DATA", ("NOT_BILLED", "METADATA_ONLY")),
]


def main() -> int:
    failures = 0
    for label, reservation, billed, error, cache, stmt, expected in CASES:
        actual = classify(reservation, billed, error, cache, stmt)
        if actual != expected:
            failures += 1
            print(f"FAIL  {label}\n        expected {expected} / actual {actual}")
        else:
            print(f"ok    {label}  -> {actual[0]}"
                  + (f" / {actual[1]}" if actual[1] else ""))

    # 不変条件: 課金額が 0 になるのは NOT_BILLED のときだけ、という対応が崩れていないか。
    for label, reservation, billed, error, cache, stmt, _ in CASES:
        model, reason = classify(reservation, billed, error, cache, stmt)
        if model == "ON_DEMAND" and (billed or 0) == 0:
            failures += 1
            print(f"FAIL  不変条件: ON_DEMAND なのに課金対象バイトが 0 ({label})")
        if model == "NOT_BILLED" and reason is None:
            failures += 1
            print(f"FAIL  不変条件: NOT_BILLED なのに内訳が NULL ({label})")
        if model != "NOT_BILLED" and reason is not None:
            failures += 1
            print(f"FAIL  不変条件: {model} なのに内訳が入っている ({label})")

    print(f"\n{'すべて通過' if not failures else str(failures) + ' 件失敗'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
