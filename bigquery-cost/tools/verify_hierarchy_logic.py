#!/usr/bin/env python3
"""bqc_vw_t_job_cost_resolved の親子分類ロジックを再現して不変条件を検証する。

ビュー本体は BigQuery でしか動かせないので、同じ規則をここに写して性質を確かめる。
ロジックを変えたら両方直すこと（pipeline/01 の STEP 4 と 1:1 対応）。

検証する不変条件:
  SUM(root_slot_hours) == SUM(statement_slot_hours) == 総消費量

  python3 tools/verify_hierarchy_logic.py
"""
import sys


def resolve(rows):
    """pipeline/01 STEP 4 の分類をそのまま再現する。

    rows: [{job_id, parent_job_id, statement_type, slot}]
    """
    job_ids = {r["job_id"] for r in rows}
    parent_ids = {r["parent_job_id"] for r in rows if r["parent_job_id"] is not None}

    out = []
    for r in rows:
        is_child = r["parent_job_id"] is not None
        has_child_jobs = r["job_id"] in parent_ids
        # 親の「行」が実在するか。親IDを持っていても行が無ければ孤児。
        has_parent_row = is_child and r["parent_job_id"] in job_ids

        job_role = "PARENT" if has_child_jobs else ("CHILD" if is_child else "STANDALONE")
        is_cost_countable = (not has_child_jobs) and r["statement_type"] != "SCRIPT"
        is_root_job = not has_parent_row
        root_job_id = r["parent_job_id"] if has_parent_row else r["job_id"]

        out.append({
            **r,
            "job_role": job_role,
            "is_cost_countable": is_cost_countable,
            "is_root_job": is_root_job,
            "root_job_id": root_job_id,
            "root_slot": r["slot"] if is_root_job else None,
            "statement_slot": r["slot"] if is_cost_countable else None,
        })
    return out


def _sum(rows, key):
    return sum(r[key] for r in rows if r[key] is not None)


def _case(label, rows, expect_total, expect_equal=True):
    resolved = resolve(rows)
    root = _sum(resolved, "root_slot")
    stmt = _sum(resolved, "statement_slot")
    problems = []
    if expect_equal and root != stmt:
        problems.append(f"root={root} != statement={stmt}")
    if root != expect_total:
        problems.append(f"root={root} != expected total {expect_total}")
    if expect_equal and stmt != expect_total:
        problems.append(f"statement={stmt} != expected total {expect_total}")
    if problems:
        print(f"FAIL  {label}: " + " / ".join(problems))
        for r in resolved:
            print(f"        {r['job_id']:12} role={r['job_role']:10} "
                  f"root={r['root_slot']} stmt={r['statement_slot']} "
                  f"root_job_id={r['root_job_id']}")
        return 1
    print(f"ok    {label}  (root={root}, statement={stmt})")
    return 0


def main() -> int:
    failures = 0

    # スクリプト1本（親 + 子2本）。親の値は子の合計に一致する。
    failures += _case(
        "親+子: どちらの系統でも総量が一致する",
        [
            {"job_id": "P1", "parent_job_id": None, "statement_type": "SCRIPT", "slot": 30},
            {"job_id": "C1", "parent_job_id": "P1", "statement_type": "SELECT", "slot": 10},
            {"job_id": "C2", "parent_job_id": "P1", "statement_type": "SELECT", "slot": 20},
        ],
        expect_total=30,
    )

    # 単独ジョブは両方の系統に同じ値が入る。
    failures += _case(
        "単独ジョブ: 両方の系統に計上される",
        [{"job_id": "S1", "parent_job_id": None, "statement_type": "SELECT", "slot": 7}],
        expect_total=7,
    )

    # 混在。
    failures += _case(
        "親+子+単独の混在",
        [
            {"job_id": "P1", "parent_job_id": None, "statement_type": "SCRIPT", "slot": 30},
            {"job_id": "C1", "parent_job_id": "P1", "statement_type": "SELECT", "slot": 10},
            {"job_id": "C2", "parent_job_id": "P1", "statement_type": "SELECT", "slot": 20},
            {"job_id": "S1", "parent_job_id": None, "statement_type": "SELECT", "slot": 7},
        ],
        expect_total=37,
    )

    # 孤児: 親が刈り取られ、子だけが残った状態。
    # is_root_job を parent_job_id IS NULL で定義していると、この子はどちらの
    # 代表にもならず root 側の合計から静かに抜け落ちる。
    failures += _case(
        "孤児（親が刈り取られた子）: root 側から抜け落ちない",
        [
            {"job_id": "O1", "parent_job_id": "GONE", "statement_type": "SELECT", "slot": 5},
            {"job_id": "S1", "parent_job_id": None, "statement_type": "SELECT", "slot": 7},
        ],
        expect_total=12,
    )

    # 孤児が兄弟と一緒に残っているケース（親だけ消えた）。
    failures += _case(
        "孤児が複数（親だけ消えた）",
        [
            {"job_id": "O1", "parent_job_id": "GONE", "statement_type": "SELECT", "slot": 5},
            {"job_id": "O2", "parent_job_id": "GONE", "statement_type": "SELECT", "slot": 9},
        ],
        expect_total=14,
    )

    # 既知の非対称: 子が全部消えて親だけが残ったケース。
    # 親は SCRIPT なので statement 側には計上されず、root 側にだけ残る。
    # 消費自体は実在するので root 側で数えるのが正しく、equality は成立しない。
    resolved = resolve([
        {"job_id": "P2", "parent_job_id": None, "statement_type": "SCRIPT", "slot": 40},
    ])
    root, stmt = _sum(resolved, "root_slot"), _sum(resolved, "statement_slot")
    if root == 40 and stmt == 0:
        print("ok    既知の非対称（子が全部消えた親）: root=40 / statement=0 "
              "-- 消費は実在するので root 側で数えるのが正しい")
    else:
        failures += 1
        print(f"FAIL  既知の非対称: root={root} statement={stmt} (expected 40 / 0)")

    print(f"\n{'すべて通過' if not failures else str(failures) + ' 件失敗'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
