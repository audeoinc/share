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


# BigQuery の LIMIT は定数リテラルしか受け付けない。スクリプト変数や
# クエリパラメータを書くと実行時に「LIMIT expects an INT64 literal」で落ちる。
# sqlglot は構文としては通してしまうので、専用に見る。
# 文字列リテラルの終端やカンマを引数として拾わないよう、区切り文字は除外する。
LIMIT_ARG = re.compile(r"""\bLIMIT\s+([^\s;),'"`]+)""")


def _check_limit_literals(path: str, source: str) -> list:
    problems = []
    for number, raw in enumerate(source.split("\n"), start=1):
        line = raw.strip()
        if line.startswith("--"):
            continue
        for match in LIMIT_ARG.finditer(line):
            argument = match.group(1)
            if not argument.isdigit():
                problems.append(
                    f"{path}:{number}: LIMIT に定数以外 ({argument}) を渡している。"
                    "BigQuery はリテラルしか受け付けない（QUALIFY ROW_NUMBER() で代替する）"
                )
    return problems


# 01 の CREATE TABLE の列定義
DDL_TABLE = re.compile(
    r"CREATE OR REPLACE TABLE `%s` \(\n(.*?)\n    \)", re.DOTALL)
DDL_COLUMN = re.compile(
    r"^\s{6}([a-z_]+)\s+(?:STRING|INT64|FLOAT64|DATE|TIMESTAMP|BOOL)", re.M)
# 03 の MERGE の INSERT (...) VALUES (...)
MERGE_INSERT = re.compile(
    r"INSERT \(\n(.*?)\n\s*\) VALUES \(\n(.*?)\n\s*\)", re.DOTALL)


def _split_items(text: str) -> list:
    return [item.strip() for item in text.replace("\n", " ").split(",") if item.strip()]


def _check_insert_column_alignment(setup_source: str, refresh_source: str) -> list:
    """01 の CREATE TABLE と 03 の INSERT 列リストがずれていないかを見る。

    列を1つ足したときに片方だけ直す事故が起きやすい。実行すれば BigQuery が
    エラーにしてくれるが、流す前に気づけるほうがよい。
    """
    problems = []
    ddl_tables = [set(DDL_COLUMN.findall(body)) for body in DDL_TABLE.findall(setup_source)]

    for index, (columns_text, values_text) in enumerate(
            MERGE_INSERT.findall(refresh_source), start=1):
        columns = _split_items(columns_text)
        values = _split_items(values_text)

        if len(columns) != len(values):
            problems.append(
                f"03 の INSERT #{index}: 列リスト {len(columns)} 個と "
                f"VALUES {len(values)} 個の数が合わない")
            continue

        for column, value in zip(columns, values):
            # source.X 以外（CURRENT_TIMESTAMP() 等の式）は名前照合の対象外。
            if value.startswith("source.") and value[len("source."):] != column:
                problems.append(
                    f"03 の INSERT #{index}: 列 {column} の位置に {value} が来ている")

        if set(columns) not in ddl_tables:
            problems.append(
                f"03 の INSERT #{index}: 列の集合が 01 のどの CREATE TABLE とも一致しない "
                f"（列を片方だけ足した可能性）")

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

        limit_problems = _check_limit_literals(path, source)
        for problem in limit_problems:
            failures += 1
            checked += 1
            print(f"FAIL  {problem}")
        if not limit_problems:
            checked += 1
            print(f"ok    {path}: LIMIT が定数")

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

    setup_path = "pipeline/01_setup_cost_environment.sql"
    refresh_path = "pipeline/03_refresh_reports.sql"
    try:
        alignment_problems = _check_insert_column_alignment(
            open(setup_path, encoding="utf-8").read(),
            open(refresh_path, encoding="utf-8").read(),
        )
    except FileNotFoundError:
        alignment_problems = []
    else:
        for problem in alignment_problems:
            failures += 1
            checked += 1
            print(f"FAIL  {problem}")
        if not alignment_problems:
            checked += 1
            print("ok    01 の CREATE TABLE と 03 の INSERT 列リストが整合")

    print(f"\n{checked - failures}/{checked} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
