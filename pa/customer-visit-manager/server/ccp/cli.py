"""運用用のコマンド。

  python -m ccp.cli migrate          テーブルを作る(なければ作り、足りない列は足す)
  python -m ccp.cli seed [--reset]   初期データ(server/seed.json)を入れる。--reset は、中身を消してから
  python -m ccp.cli counts           各テーブルの件数

接続先は、db.py の環境変数(CLOUD_SQL_INSTANCE / DB_PASSWORD など、または DATABASE_URL)。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import text

from . import schema as sc
from .db import get_engine

SEED_PATH = Path(__file__).resolve().parent.parent / "seed.json"


async def migrate() -> None:
    engine = await get_engine()
    async with engine.begin() as conn:
        for stmt in sc.load().ddl():
            await conn.execute(text(stmt))
    print("テーブルを作成・更新しました")


async def seed(reset: bool) -> None:
    schema = sc.load()
    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    engine = await get_engine()
    async with engine.begin() as conn:
        order = schema.creation_order()
        if reset:
            for t in reversed(order):
                await conn.execute(text(f"DELETE FROM {t.pg}"))
        for t in order:
            rows = data.get(t.dv, [])
            for rec in rows:
                values = t.to_db(rec)
                values["id"] = sc.coerce("uuid", rec[t.pk])
                cols = list(values)
                await conn.execute(
                    text(f"INSERT INTO {t.pg} ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)}) ON CONFLICT (id) DO NOTHING"),
                    values,
                )
            print(f"{t.pg}: {len(rows)} 件")


async def counts() -> None:
    engine = await get_engine()
    async with engine.connect() as conn:
        for t in sc.load().creation_order():
            n = (await conn.execute(text(f"SELECT count(*) FROM {t.pg}"))).scalar_one()
            print(f"{t.pg}: {n}")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    s = sub.add_parser("seed")
    s.add_argument("--reset", action="store_true")
    sub.add_parser("counts")
    args = p.parse_args()
    if args.cmd == "migrate":
        asyncio.run(migrate())
    elif args.cmd == "seed":
        asyncio.run(seed(args.reset))
    else:
        asyncio.run(counts())


if __name__ == "__main__":
    main()
