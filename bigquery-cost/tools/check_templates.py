#!/usr/bin/env python3
"""pipeline/*.sql と adhoc/*.sql を静的に検査する。

動的SQLテンプレートを取り出し、
FORMAT の %s を埋めたうえで sqlglot(bigquery) にパースさせる静的チェック。

BigQuery のスクリプト構文（BEGIN / DECLARE / EXECUTE IMMEDIATE）は sqlglot が
解釈できないためファイル全体はパースできないが、生成される「中身」の SQL は
パースできる。タイプミスや括弧の閉じ忘れはここで捕まる。

  python3 tools/check_templates.py
"""
import glob
import re
import sys

import sqlglot

# FORMAT(r"""...""") の中身。パターン側にクォート3連は出てこない前提
# （tools/normalize_reference.py の埋め込み安全性チェックを参照）。
TEMPLATE = re.compile(r'FORMAT\(\s*r"""(.*?)"""', re.DOTALL)


def _fill_placeholders(sql: str) -> str:
    """FORMAT の %s を、構文的に妥当なダミーで埋める。"""
    # UDF テンプレートのバッククォート置換引数だけは識別子ではなく文字列。
    sql = sql.replace(r"r'`([^`]*)`', %s)", r"r'`([^`]*)`', r'\1')")
    return sql.replace("%s", "dummy_project.dummy_dataset.dummy_object")


def _check_declare_order(path: str, source: str) -> list:
    """BigQuery スクリプトの DECLARE は、そのブロックの最初の実行文より前に
    まとめて置かなければならない。あとから変数を足したときに壊しやすいので機械的に見る。"""
    problems = []
    seen_statement = None
    for number, raw in enumerate(source.split("\n"), start=1):
        line = raw.strip()
        if not line or line.startswith("--"):
            continue
        if line.startswith("DECLARE ") and seen_statement is not None:
            problems.append(
                f"{path}:{number}: DECLARE が実行文 ({path}:{seen_statement}) より後ろにある"
            )
        elif seen_statement is None and not line.startswith(("DECLARE ", "BEGIN", "SET @@")):
            seen_statement = number
    return problems


def main() -> int:
    failures = 0
    checked = 0

    for path in sorted(glob.glob("pipeline/*.sql") + glob.glob("adhoc/*.sql")):
        source = open(path, encoding="utf-8").read()

        declare_problems = _check_declare_order(path, source)
        for problem in declare_problems:
            failures += 1
            checked += 1
            print(f"FAIL  {problem}")
        if not declare_problems:
            checked += 1
            print(f"ok    {path}: DECLARE の位置")

        templates = TEMPLATE.findall(source)
        if not templates:
            print(f"--    {path}: FORMAT(r\"\"\"...\"\"\") テンプレートなし")
            continue

        for index, template in enumerate(templates, start=1):
            checked += 1
            filled = _fill_placeholders(template)
            label = f"{path} template#{index}"
            try:
                statements = sqlglot.parse(filled, dialect="bigquery")
                kind = statements[0].key if statements and statements[0] else "?"
                print(f"ok    {label}  ({kind}, {len(filled)} chars)")
            except Exception as error:  # noqa: BLE001 - 表示目的
                failures += 1
                print(f"FAIL  {label}: {str(error)[:300]}")

    print(f"\n{checked - failures}/{checked} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
