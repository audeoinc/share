"""CCP(Campaign Contents Planner)の GCP 版サーバー。

1 つのプロセスで、画面(ビルド済みの dist-gcp)・データ API・AI(次の段階)を配信する。
アクセスは HTTP Basic 認証(環境変数 APP_PASSWORD。営業支援システムと同じ仕組み)。
"""
from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

import asyncio

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import dbctl
from .ai import router as ai_router
from .data_api import register_errors, router as data_router

APP_PASSWORD = os.getenv("APP_PASSWORD")
STATIC_DIR = Path(os.getenv("STATIC_DIR") or Path(__file__).resolve().parents[2] / "dist-gcp")

app = FastAPI(title="CCP", docs_url=None, redoc_url=None)
register_errors(app)


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    # 死活確認(中身は何も返さない)と、Cloud Scheduler からの内部の呼び出し(下で、Google の署名つきトークンを確認する)は、Basic 認証の対象外
    path = request.url.path
    if APP_PASSWORD and path != "/ping" and not path.startswith("/internal/"):
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


@app.get("/ping")
async def healthz():
    return {"ok": True}


@app.get("/api/db/status")
async def db_status():
    """画面の「準備中」表示が、数秒おきに呼ぶ。止まっていれば、起動も依頼する"""
    if not dbctl.enabled():
        return {"state": "running"}
    c = dbctl.controller()
    try:
        await c.ensure_running()
    except dbctl.DbNotReady:
        pass
    return {"state": await c.status(fresh=True)}


@app.post("/internal/idle-check")
async def idle_check(request: Request):
    """Cloud Scheduler が定期的に呼ぶ。最後のアクセスから一定時間たっていたら、DB を停止する"""
    if not dbctl.enabled():
        return {"action": "none", "note": "DB の自動制御は無効です"}
    await _verify_scheduler(request)
    return await dbctl.controller().idle_check(float(os.getenv("DB_IDLE_MINUTES", "30")))


async def _verify_scheduler(request: Request) -> None:
    """Cloud Scheduler の署名つき(OIDC)トークンだけを受け付ける"""
    from google.auth.transport import requests as greq
    from google.oauth2 import id_token

    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer "):
        raise HTTPException(401, "token required")
    try:
        claims = await asyncio.to_thread(id_token.verify_oauth2_token, header[7:], greq.Request(), os.environ["IDLE_CHECK_AUDIENCE"])
    except Exception as e:  # noqa: BLE001 — 署名・有効期限・宛先の不一致は、すべて拒否
        raise HTTPException(401, "invalid token") from e
    if claims.get("email") != os.environ["IDLE_CHECK_SA_EMAIL"] or not claims.get("email_verified"):
        raise HTTPException(403, "forbidden")


app.include_router(data_router)
app.include_router(ai_router)

if STATIC_DIR.is_dir():
    # 画面。API より後に登録して、/api が先に処理されるようにする
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
