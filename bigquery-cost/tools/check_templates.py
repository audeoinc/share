#!/usr/bin/env python3
"""pipeline/*.sql の中に埋め込まれた動的SQLテンプレートを取り出し、
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


def main() -> int:
    failures = 0
    checked = 0

    for path in sorted(glob.glob("pipeline/*.sql")):
        source = open(path, encoding="utf-8").read()
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

    print(f"\n{checked - failures}/{checked} templates parsed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
