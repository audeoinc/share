"""/api/ask — 画面から受け取った依頼文を Gemini(Vertex AI)に渡し、返答のテキストをそのまま返す。

プロンプトの作り方・返答の JSON の解釈・やり直しは、画面側(src/aiSelect.ts)にあり、Power Apps 版と共通。
ここは「文字列を渡して、文字列を受け取る」だけにして、2 つのビルドで AI の動きがずれないようにする。

設定(環境変数。営業支援システムと同じ Vertex AI):
  GOOGLE_CLOUD_PROJECT   プロジェクト ID(コードには書かない)
  GOOGLE_CLOUD_LOCATION  既定 global
  GEMINI_MODEL           既定 gemini-3.5-flash
  GEMINI_THINKING        思考の深さ(minimal / low / medium / high)。既定 low(1 回の下書きで 6〜9 回呼ぶため、速さを優先)
"""
from __future__ import annotations

import logging
import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

from .creds import get_credentials

log = logging.getLogger("ccp.ai")
router = APIRouter(prefix="/api")

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=True,
            project=os.environ["GOOGLE_CLOUD_PROJECT"],
            location=os.getenv("GOOGLE_CLOUD_LOCATION", "global"),
            credentials=get_credentials(),
        )
    return _client


class AskIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=400_000)


@router.post("/ask")
async def ask(body: AskIn):
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
    level = os.getenv("GEMINI_THINKING", "low").upper()
    try:
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
        return JSONResponse({"success": False, "error": {"message": f"AI の呼び出しに失敗しました: {type(e).__name__}: {e}"[:600]}}, status_code=502)
    if not text:
        return JSONResponse({"success": False, "error": {"message": "AI の返答が空でした(安全フィルターなどで止まった可能性があります)"}}, status_code=502)
    return {"success": True, "text": text}
