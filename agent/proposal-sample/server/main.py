"""ダッシュボード用のアプリ＆エージェント・サーバ（FastAPI）。

役割:
- 静的UI(web/)の配信
- BQ/GCS相当データ(store.py)の参照・更新 ← 同一プロセス内（1コンテナ1ポート）
- ADK Runner による「分析→提案生成」の実行と、下書き保存/BQ書き戻し
- （任意）簡易パスワード(HTTP Basic)によるアクセス制限

ローカル起動:
    ./.venv/Scripts/python.exe -m uvicorn server.main:app --port 8000 --reload
Cloud Run では PORT 環境変数のポートで起動する（Dockerfile 参照）。
"""
from __future__ import annotations

import base64
import json
import os
import secrets
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

# ローカル用の .env があれば読み込む（Cloud Run では環境変数を直接設定するため無くてもよい）。
_ENV = Path(__file__).resolve().parent.parent / "proposal_app" / ".env"
if _ENV.exists():
    load_dotenv(_ENV)

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from fastapi.responses import FileResponse, Response, StreamingResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from proposal_app import store, tools  # noqa: E402
from server.evaluator import evaluate  # noqa: E402
from server.pipeline import (  # noqa: E402
    chat_stream,
    generate_proposal,
    generate_proposal_stream,
    refine_proposal,
    refine_proposal_stream,
)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# 設定していれば全リクエストに Basic 認証をかける（公開時の無断利用・課金防止）。
APP_PASSWORD = os.getenv("APP_PASSWORD")

app = FastAPI(title="顧客提案ジェネレーター")


@app.middleware("http")
async def gatekeeper(request, call_next):
    # 1) 簡易パスワード（APP_PASSWORD 設定時のみ有効）
    if APP_PASSWORD:
        ok = False
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                _, pw = base64.b64decode(header[6:]).decode("utf-8").split(":", 1)
                ok = secrets.compare_digest(pw, APP_PASSWORD)
            except Exception:
                ok = False
        if not ok:
            return Response(
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="proposal"'},
            )
    # 2) 静的ファイルはキャッシュさせない（UI編集の即反映）
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---- リクエストモデル --------------------------------------------------------

class GenerateReq(BaseModel):
    customer_id: str


class RefineReq(BaseModel):
    customer_id: str
    analysis: str
    previous_proposal: dict
    instruction: str


class ChatReq(BaseModel):
    customer_id: str
    message: str
    reset: bool = False  # True=これまでの会話を破棄して新しく相談を始める


class ApproveReq(BaseModel):
    customer_id: str
    title: str
    body: str
    recommended_product_ids: list[str]
    proposal_id: int | None = None  # 指定あり=既存を更新 / なし=新規作成


class EvaluateReq(BaseModel):
    customer_id: str
    analysis: str
    proposal: dict


def _record_version(customer_id: str, source: str, analysis: str, proposal: dict,
                    thinking: str = "") -> dict:
    """生成/再提案の結果を版として履歴に記録する。"""
    return store.create_version({
        "customer_id": customer_id,
        "source": source,  # "generate" or "refine"
        "analysis": analysis or "",
        "thinking": thinking or "",
        "title": proposal.get("title", ""),
        "body": proposal.get("body", ""),
        "recommended_product_ids": proposal.get("recommended_product_ids", []),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    })


# ---- データ参照（BQ/GCS相当のproxy） ----------------------------------------

@app.get("/api/customers")
def api_customers():
    return tools.list_customers()


@app.get("/api/customers/{customer_id}")
def api_customer(customer_id: str):
    detail = tools.get_customer_detail(customer_id)
    if detail.get("error"):
        raise HTTPException(status_code=404, detail=detail["error"])
    return detail


@app.get("/api/customers/{customer_id}/purchases")
def api_purchases(customer_id: str):
    return tools.get_purchase_history(customer_id)


@app.get("/api/products")
def api_products():
    return tools.list_products()


@app.get("/api/proposals")
def api_proposals(customer_id: str | None = None):
    """保存済み提案の一覧。customer_id 指定でその顧客の提案だけに絞る。"""
    return store.list_proposals(customer_id)


@app.get("/api/versions")
def api_versions(customer_id: str | None = None):
    """生成/再提案の版履歴。customer_id 指定でその顧客の履歴だけに絞る。"""
    return store.list_versions(customer_id)


@app.delete("/api/proposals/{proposal_id}")
def api_delete_proposal(proposal_id: str):
    """保存済み提案を1件削除する。"""
    if not store.delete_proposal(proposal_id):
        raise HTTPException(status_code=404, detail="proposal not found")
    return {"deleted": proposal_id}


@app.delete("/api/versions/{version_id}")
def api_delete_version(version_id: str):
    """生成履歴の版を1件削除する。"""
    if not store.delete_version(version_id):
        raise HTTPException(status_code=404, detail="version not found")
    return {"deleted": version_id}


# ---- エージェント実行・書き戻し ----------------------------------------------

@app.post("/api/generate")
async def api_generate(req: GenerateReq):
    """分析→提案生成を実行し、下書き(GCS相当)に保存して返す。"""
    result = await generate_proposal(req.customer_id)
    proposal = result.get("proposal") or {}
    thinking = result.get("thinking", "")
    draft = tools.save_draft_to_gcs(
        customer_id=req.customer_id,
        title=proposal.get("title", ""),
        body=proposal.get("body", ""),
        recommended_product_ids=proposal.get("recommended_product_ids", []),
    )
    version = _record_version(req.customer_id, "generate", result.get("analysis", ""),
                              proposal, thinking)
    return {
        "analysis": result.get("analysis", ""),
        "proposal": proposal,
        "thinking": thinking,
        "draft_id": draft.get("draft_id"),
        "version_id": version.get("id"),
    }


def _sse(event: str, data: dict) -> str:
    """Server-Sent Events の1メッセージ（JSONは1行にエンコード）。"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/generate_stream")
async def api_generate_stream(req: GenerateReq):
    """生成をSSEでストリーミング。分析の差分を逐次流し、最後に done で確定値を返す。"""

    async def event_gen():
        try:
            async for msg in generate_proposal_stream(req.customer_id):
                if msg["type"] == "final":
                    proposal = msg.get("proposal") or {}
                    analysis = msg.get("analysis", "")
                    thinking = msg.get("thinking", "")
                    draft = tools.save_draft_to_gcs(
                        customer_id=req.customer_id,
                        title=proposal.get("title", ""),
                        body=proposal.get("body", ""),
                        recommended_product_ids=proposal.get("recommended_product_ids", []),
                    )
                    version = _record_version(req.customer_id, "generate", analysis, proposal, thinking)
                    yield _sse("done", {
                        "analysis": analysis,
                        "proposal": proposal,
                        "thinking": thinking,
                        "draft_id": draft.get("draft_id"),
                        "version_id": version.get("id"),
                    })
                else:
                    yield _sse(msg["type"], msg)
        except Exception as e:  # クライアントにエラーを通知
            yield _sse("error", {"text": str(e)})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/refine")
async def api_refine(req: RefineReq):
    """ユーザー指示を反映して提案だけを作り直し、下書きを更新して返す。"""
    result = await refine_proposal(
        customer_id=req.customer_id,
        analysis=req.analysis,
        previous_proposal=req.previous_proposal,
        instruction=req.instruction,
    )
    proposal = result.get("proposal") or {}
    thinking = result.get("thinking", "")
    draft = tools.save_draft_to_gcs(
        customer_id=req.customer_id,
        title=proposal.get("title", ""),
        body=proposal.get("body", ""),
        recommended_product_ids=proposal.get("recommended_product_ids", []),
    )
    version = _record_version(req.customer_id, "refine", result.get("analysis", ""),
                              proposal, thinking)
    return {
        "analysis": result.get("analysis", ""),
        "proposal": proposal,
        "thinking": thinking,
        "draft_id": draft.get("draft_id"),
        "version_id": version.get("id"),
    }


@app.post("/api/refine_stream")
async def api_refine_stream(req: RefineReq):
    """再提案をSSEでストリーミング。思考を逐次流し、最後に done で確定値を返す。"""

    async def event_gen():
        try:
            async for msg in refine_proposal_stream(
                customer_id=req.customer_id,
                analysis=req.analysis,
                previous_proposal=req.previous_proposal,
                instruction=req.instruction,
            ):
                if msg["type"] == "final":
                    proposal = msg.get("proposal") or {}
                    analysis = msg.get("analysis", "")
                    thinking = msg.get("thinking", "")
                    draft = tools.save_draft_to_gcs(
                        customer_id=req.customer_id,
                        title=proposal.get("title", ""),
                        body=proposal.get("body", ""),
                        recommended_product_ids=proposal.get("recommended_product_ids", []),
                    )
                    version = _record_version(req.customer_id, "refine", analysis, proposal, thinking)
                    yield _sse("done", {
                        "analysis": analysis,
                        "proposal": proposal,
                        "thinking": thinking,
                        "draft_id": draft.get("draft_id"),
                        "version_id": version.get("id"),
                    })
                else:
                    yield _sse(msg["type"], msg)
        except Exception as e:
            yield _sse("error", {"text": str(e)})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/chat_stream")
async def api_chat_stream(req: ChatReq):
    """対話（往復）をSSEでストリーミング。

    エージェントは質問を返すこともあり（proposal=None）、要件が揃うと emit_proposal で
    提案を確定する。確定時は下書き保存＋版履歴への記録まで行い、生成/再提案と同じ導線
    （評価・承認・履歴）にそのまま乗せられるようにする。
    """

    async def event_gen():
        try:
            async for msg in chat_stream(req.customer_id, req.message, reset=req.reset):
                if msg["type"] == "final":
                    reply = msg.get("reply", "")
                    thinking = msg.get("thinking", "")
                    proposal = msg.get("proposal")
                    done = {"reply": reply, "thinking": thinking, "proposal": None}
                    if proposal:
                        draft = tools.save_draft_to_gcs(
                            customer_id=req.customer_id,
                            title=proposal.get("title", ""),
                            body=proposal.get("body", ""),
                            recommended_product_ids=proposal.get("recommended_product_ids", []),
                        )
                        version = _record_version(req.customer_id, "chat", "", proposal, thinking)
                        done["proposal"] = proposal
                        done["draft_id"] = draft.get("draft_id")
                        done["version_id"] = version.get("id")
                    yield _sse("done", done)
                else:
                    yield _sse(msg["type"], msg)
        except Exception as e:
            yield _sse("error", {"text": str(e)})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/evaluate")
async def api_evaluate(req: EvaluateReq):
    """現在の提案を LLM-as-judge で採点する（grounding/relevance/actionability + 平均）。"""
    customer = store.get_customer(req.customer_id) or {}
    return await evaluate(customer, req.analysis, req.proposal)


@app.post("/api/approve")
def api_approve(req: ApproveReq):
    """提案をBQ相当(proposals)に保存する。
    proposal_id 指定あり=既存を上書き更新、なし=新規作成。"""
    if req.proposal_id is not None:
        return tools.update_proposal_in_bq(
            proposal_id=str(req.proposal_id),
            customer_id=req.customer_id,
            title=req.title,
            body=req.body,
            recommended_product_ids=req.recommended_product_ids,
        )
    return tools.write_proposal_to_bq(
        customer_id=req.customer_id,
        title=req.title,
        body=req.body,
        recommended_product_ids=req.recommended_product_ids,
    )


# ---- 静的UI ------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
