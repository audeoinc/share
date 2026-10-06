"""PostgreSQL(Cloud SQL)への接続。

- 本番(Cloud Run): CLOUD_SQL_INSTANCE=<プロジェクト>:<リージョン>:<インスタンス> と DB_USER / DB_PASSWORD / DB_NAME。
  Cloud SQL Python Connector 経由(認証・暗号化は、コネクタが行う)。
- 手元の別の PostgreSQL を使うとき: DATABASE_URL=postgresql+asyncpg://user:pass@host/db
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from .creds import get_credentials

_engine: AsyncEngine | None = None
_lock: asyncio.Lock | None = None


async def reset_engine() -> None:
    """接続に失敗したとき、次の接続を、作り直した状態から始める(DB の再起動前の接続情報を、引きずらないため)"""
    global _engine
    engine, _engine = _engine, None
    if engine is not None:
        try:
            await engine.dispose()
        except Exception:  # noqa: BLE001 — 後始末の失敗は無視する
            pass


async def get_engine() -> AsyncEngine:
    global _engine, _lock
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:
        if _engine is not None:
            return _engine
        url = os.getenv("DATABASE_URL")
        if url:
            _engine = create_async_engine(url, pool_size=3, max_overflow=2, pool_pre_ping=True)
            return _engine

        from google.cloud.sql.connector import Connector

        instance = os.environ["CLOUD_SQL_INSTANCE"]
        user, password, name = os.getenv("DB_USER", "ccp_app"), os.environ["DB_PASSWORD"], os.getenv("DB_NAME", "ccp")
        connector = Connector(loop=asyncio.get_running_loop(), refresh_strategy="lazy", credentials=get_credentials())

        async def creator() -> Any:
            return await connector.connect_async(instance, "asyncpg", user=user, password=password, db=name)

        _engine = create_async_engine("postgresql+asyncpg://", async_creator=creator, pool_size=3, max_overflow=2, pool_pre_ping=True, pool_recycle=300)
        return _engine
