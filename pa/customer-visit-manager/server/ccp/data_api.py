"""/api/data/{テーブル} — 画面(generated/services の互換サービス)から呼ばれる、データの読み書き。

テーブル名と項目名は、Dataverse の名前(cr854_…)で受け取り、schema.py が PostgreSQL の名前に変換する。
受け付けるのは、schema.json にあるテーブルと列だけ。値はすべて、パラメータとして渡す(SQL に直接埋め込まない)。
"""
from __future__ import annotations

from typing import Any

import aiohttp

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncConnection

from . import dbctl, schema as sc
from .db import get_engine, reset_engine



async def require_db() -> None:
    """DB が止まっていれば、起動を依頼して「準備中」と返す。使える間は、最後のアクセスの時刻を残す"""
    if dbctl.enabled():
        c = dbctl.controller()
        await c.ensure_running()
        await c.touch()


@asynccontextmanager
async def db(write: bool = False) -> AsyncIterator[AsyncConnection]:
    """DB に接続する(write=True なら、トランザクションつき)。起動の途中などで接続できないときは、500 ではなく「準備中」として扱う"""
    conn = (await get_engine()).connect()
    try:
        await conn.start()
    except (SQLAlchemyError, OSError, aiohttp.ClientError, asyncio.TimeoutError, KeyError) as e:
        await reset_engine()
        raise dbctl.DbNotReady("starting") from e
    try:
        if write:
            async with conn.begin():
                yield conn
        else:
            yield conn
    finally:
        await conn.close()


router = APIRouter(prefix="/api/data", dependencies=[Depends(require_db)])
SCHEMA = sc.load()


def ok(data: Any) -> dict[str, Any]:
    return {"success": True, "data": data}


def fail(status: int, message: str, code: str | None = None) -> JSONResponse:
    err: dict[str, Any] = {"message": message}
    if code:
        err["code"] = code
    return JSONResponse({"success": False, "error": err}, status_code=status)


def _columns_sql(t: sc.Table, names: list[str] | None) -> str:
    if not names:
        cols = ["id"] + [c.pg for c in t.all_columns] + [lk.pg for lk in t.lookups]
    else:
        cols = ["id"] + [t.resolve(n.strip())[0] for n in names if n.strip() != t.pk]
    return ", ".join(dict.fromkeys(cols))


@router.get("/{table}")
async def list_rows(
    table: str,
    filter: str | None = None,
    orderBy: str | None = None,
    select: str | None = None,
    top: int | None = Query(None, ge=1, le=5000),
    skip: int = Query(0, ge=0),
):
    t = SCHEMA.table(table)
    where, params = sc.parse_filter(t, filter)
    order = sc.parse_order(t, [orderBy] if orderBy else None) or "created_on ASC, id ASC"
    sql = f"SELECT {_columns_sql(t, select.split(',') if select else None)} FROM {t.pg}"
    if where:
        sql += f" WHERE {where}"
    sql += f" ORDER BY {order}"
    if top:
        sql += " LIMIT :_top"
        params["_top"] = top
    if skip:
        sql += " OFFSET :_skip"
        params["_skip"] = skip
    async with db() as conn:
        rows = (await conn.execute(text(sql), params)).mappings().all()
    return ok([t.to_api(dict(r)) for r in rows])


@router.get("/{table}/{row_id}")
async def get_row(table: str, row_id: str):
    t = SCHEMA.table(table)
    rid = sc.coerce("uuid", row_id)
    async with db() as conn:
        row = (await conn.execute(text(f"SELECT {_columns_sql(t, None)} FROM {t.pg} WHERE id = :id"), {"id": rid})).mappings().first()
    if row is None:
        return fail(404, "レコードが見つかりません")
    return ok(t.to_api(dict(row)))


@router.post("/{table}")
async def create_row(table: str, request: Request):
    t = SCHEMA.table(table)
    values = t.to_db(await _body(request))
    cols = list(values)
    returning = _columns_sql(t, None)
    if cols:
        sql = f"INSERT INTO {t.pg} ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)}) RETURNING {returning}"
    else:
        sql = f"INSERT INTO {t.pg} DEFAULT VALUES RETURNING {returning}"
    async with db(write=True) as conn:
        row = (await conn.execute(text(sql), values)).mappings().one()
    return ok(t.to_api(dict(row)))


@router.patch("/{table}/{row_id}")
async def update_row(table: str, row_id: str, request: Request):
    t = SCHEMA.table(table)
    values = t.to_db(await _body(request))
    sets = [f"{c} = :{c}" for c in values] + ["modified_on = now()"]
    sql = f"UPDATE {t.pg} SET {', '.join(sets)} WHERE id = :_id RETURNING {_columns_sql(t, None)}"
    async with db(write=True) as conn:
        row = (await conn.execute(text(sql), {**values, "_id": sc.coerce("uuid", row_id)})).mappings().first()
    if row is None:
        return fail(404, "レコードが見つかりません")
    return ok(t.to_api(dict(row)))


@router.delete("/{table}/{row_id}")
async def delete_row(table: str, row_id: str):
    t = SCHEMA.table(table)
    async with db(write=True) as conn:
        await conn.execute(text(f"DELETE FROM {t.pg} WHERE id = :id"), {"id": sc.coerce("uuid", row_id)})
    return ok(None)


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as e:  # 壊れた JSON・UTF-8 ではない文字(UnicodeDecodeError も ValueError の仲間)
        raise sc.BadRequest("本文が正しい JSON(UTF-8)ではありません") from e
    if not isinstance(body, dict):
        raise sc.BadRequest("本文は、オブジェクトで指定してください")
    return body


def register_errors(app: FastAPI) -> None:
    @app.exception_handler(dbctl.DbNotReady)
    async def _starting(_: Request, e: dbctl.DbNotReady):
        return fail(503, "データベースを起動しています(10 分ほどかかることがあります)", "db_starting")

    @app.exception_handler(sc.BadRequest)
    async def _bad(_: Request, e: sc.BadRequest):
        return fail(400, str(e))

    @app.exception_handler(IntegrityError)
    async def _integrity(_: Request, e: IntegrityError):
        return fail(409, "データの整合性エラー(参照先がない・必須項目が空など)")

    @app.exception_handler(DBAPIError)
    async def _db(_: Request, e: DBAPIError):
        return fail(503, "データベースに接続できません", "db_unavailable")

    @app.exception_handler(OSError)
    async def _os(_: Request, e: OSError):
        return fail(503, "データベースに接続できません", "db_unavailable")
