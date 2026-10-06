"""/api/ask — 画面から受け取った依頼文を Gemini(Vertex AI)に渡し、返答のテキストをそのまま返す。

プロンプトの作り方・返答の JSON の解釈・やり直しは、画面側(src/aiSelect.ts)にあり、Power Apps 版と共通。
ここは「文字列を渡して、文字列を受け取る」だけにして、2 つのビルドで AI の動きがずれないようにする。

設定(環境変数。営業支援システムと同じ Vertex AI):
  GOOGLE_CLOUD_PROJECT   プロジェクト ID(コードには書かない)
  GOOGLE_CLOUD_LOCATION  既定 global
  GEMINI_MODEL           既定 gemini-3.5-flash
  GEMINI_THINKING        思考の深さ(minimal / low / medium / high)。既定 low(1 回の下書きで 6〜9 回呼ぶため、速さを優先)
  GEMINI_CONCURRENCY     Gemini への同時の呼び出しの上限。既定 4(混み合いによる 429 を減らす)

混み合い(429 RESOURCE_EXHAUSTED)や一時的なサーバーエラー(500/503/504)は、SDK が間隔を空けて、最大 5 回まで自動でやり直す。
"""
from __future__ import annotations

import asyncio
import logging
import os

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from . import dbctl
from .creds import get_credentials

log = logging.getLogger("ccp.ai")


async def note_activity() -> None:
    """AI の利用も、アクセスとして数える(使っている間に、DB を止めないため)"""
    if dbctl.enabled():
        await dbctl.controller().touch()


router = APIRouter(prefix="/api", dependencies=[Depends(note_activity)])

_client: genai.Client | None = None
_gate: asyncio.Semaphore | None = None
RETRY = types.HttpRetryOptions(attempts=5, initial_delay=2.0, max_delay=30.0, exp_base=2.0, jitter=1.0, http_status_codes=[429, 500, 503, 504])


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=True,
            project=os.environ["GOOGLE_CLOUD_PROJECT"],
            location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
            credentials=get_credentials(),
            http_options=types.HttpOptions(retry_options=RETRY),
        )
    return _client


class AskIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=400_000)


@router.post("/ask")
async def ask(body: AskIn):
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
    level = os.getenv("GEMINI_THINKING", "low").upper()
    global _gate
    if _gate is None:
        _gate = asyncio.Semaphore(int(os.getenv("GEMINI_CONCURRENCY", "4")))
    try:
        async with _gate:
            resp = await _get_client().aio.models.generate_content(
                model=model,
                contents=body.prompt,
                config=types.GenerateContentConfig(
                    # 返答は JSON だけ(プロンプトでも指示しているが、形式の崩れを減らす)
                    response_mime_type="application/json",
                    thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel(level)),
                ),
            )
        text = (resp.text or "").strip()
    except Exception as e:  # noqa: BLE001 — Vertex AI のエラーは種類が多い。画面に原因を返す
        log.exception("Gemini の呼び出しに失敗しました")
        busy = "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e)
        hint = "AI が混み合っています。しばらくしてから、もう一度お試しください。" if busy else ""
        return JSONResponse({"success": False, "error": {"message": f"{hint}AI の呼び出しに失敗しました: {type(e).__name__}: {e}"[:600]}}, status_code=502)
    if not text:
        return JSONResponse({"success": False, "error": {"message": "AI の返答が空でした(安全フィルターなどで止まった可能性があります)"}}, status_code=502)
    return {"success": True, "text": text}
