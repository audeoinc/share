"""CCP(Campaign Contents Planner)の GCP 版サーバー。

1 つのプロセスで、画面(ビルド済みの dist-gcp)・データ API・AI(次の段階)を配信する。
アクセスは HTTP Basic 認証(環境変数 APP_PASSWORD。営業支援システムと同じ仕組み)。
"""
from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .data_api import register_errors, router as data_router

APP_PASSWORD = os.getenv("APP_PASSWORD")
STATIC_DIR = Path(os.getenv("STATIC_DIR") or Path(__file__).resolve().parents[2] / "dist-gcp")

app = FastAPI(title="CCP", docs_url=None, redoc_url=None)
register_errors(app)


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    # 死活確認だけは、認証なし(中身は何も返さない)
    if APP_PASSWORD and request.url.path != "/healthz":
        header = request.headers.get("authorization", "")
        ok = False
        if header.startswith("Basic "):
            try:
                _, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                ok = secrets.compare_digest(pw.encode(), APP_PASSWORD.encode())
            except Exception:  # noqa: BLE001 — 壊れた認証ヘッダーは、不一致として扱う
                ok = False
        if not ok:
            return PlainTextResponse("Unauthorized", status_code=401, headers={"WWW-Authenticate": 'Basic realm="ccp"'})
    return await call_next(request)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


app.include_router(data_router)

if STATIC_DIR.is_dir():
    # 画面。API より後に登録して、/api が先に処理されるようにする
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
