"""FastAPI のサンプル API（第一歩）。

目的:
- FastAPI で API を書く最小の形を確認する
- TestClient で「リクエスト → レスポンス」を確認する
- 状態を JSON ファイルで持つ（DB を使わない）感触をつかむ

ローカル起動:
    uvicorn app.main:app --reload --port 8000
    → http://127.0.0.1:8000/docs で自動生成された画面から試せる

最終ゴール（この先で作るもの）:
    コンテンツ生成ジョブを 開始 / 中断 / 再開 できる API。
    その状態も、ここと同じように JSON ファイルへ保存する。
"""
from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, Field

from app import state_store

app = FastAPI(
    title="Content Generator API (sample)",
    description="FastAPI と TestClient の動作確認用サンプル。",
    version="0.1.0",
)


# --- スキーマ（リクエスト / レスポンスの型）-------------------------------
#
# pydantic の BaseModel を使うと、
#   1) 入力の検証（型が違えば 422 を自動で返す）
#   2) レスポンスの形の固定
#   3) /docs のドキュメント生成
# が同時に手に入る。


class EchoRequest(BaseModel):
    """POST /echo が受け取る本文。"""

    message: str = Field(..., min_length=1, description="送りたい文字列")
    repeat: int = Field(1, ge=1, le=5, description="繰り返す回数（1〜5）")


class EchoResponse(BaseModel):
    """POST /echo が返す本文。"""

    message: str
    length: int


class StateResponse(BaseModel):
    """状態を返すエンドポイント共通のレスポンス。"""

    counter: int


class IncrementRequest(BaseModel):
    """POST /state/increment が受け取る本文。"""

    step: int = Field(1, ge=1, le=100, description="増やす量")


# --- エンドポイント --------------------------------------------------------


@app.get("/health", summary="疎通確認")
def health() -> dict[str, str]:
    """サーバが起きているかを返すだけのエンドポイント。"""
    return {"status": "ok"}


@app.get("/greet/{name}", summary="パスパラメータの例")
def greet(name: str, polite: bool = False) -> dict[str, str]:
    """パスパラメータ(name)とクエリパラメータ(polite)の受け取り方の例。

    例: GET /greet/audeo?polite=true
    """
    greeting = f"はじめまして、{name} さん。" if polite else f"やあ、{name}。"
    return {"greeting": greeting}


@app.post("/echo", response_model=EchoResponse, summary="リクエスト本文の例")
def echo(req: EchoRequest) -> EchoResponse:
    """受け取った文字列を repeat 回つなげて返す。

    入力が条件（空文字は不可、repeat は 1〜5）を満たさない場合、
    FastAPI が自動で 422 を返すので、こちらで検証コードを書く必要はない。
    """
    message = req.message * req.repeat
    return EchoResponse(message=message, length=len(message))


@app.get("/state", response_model=StateResponse, summary="現在の状態を読む")
def read_state() -> StateResponse:
    """JSON ファイルに保存されている状態を返す。"""
    return StateResponse(**state_store.load_state())


@app.post("/state/increment", response_model=StateResponse, summary="状態を更新する")
def increment(req: IncrementRequest | None = None) -> StateResponse:
    """カウンタを増やして、更新後の状態を返す。

    プロセスを再起動しても値が残ることが、JSON ファイルで状態を持つということ。
    """
    step = req.step if req else 1
    return StateResponse(**state_store.increment_counter(step))


@app.post("/state/reset", response_model=StateResponse, summary="状態を初期化する")
def reset() -> StateResponse:
    """状態を初期値に戻す。"""
    return StateResponse(**state_store.reset_state())
