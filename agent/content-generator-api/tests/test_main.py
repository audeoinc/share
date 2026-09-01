"""TestClient による API の動作確認。

TestClient は「サーバを起動せずに」FastAPI アプリへリクエストを投げられる。
uvicorn を立ち上げる必要がないので、テストが速く、CI でもそのまま動く。

実行:
    pytest -v
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """状態ファイルをテスト用の一時ファイルに向けた TestClient。

    tmp_path はテストごとに作られる空のディレクトリ。こうしておけば、
    テストが実データ(data/state.json)を書き換えることがない。
    """
    monkeypatch.setenv("CONTENT_API_STATE_FILE", str(tmp_path / "state.json"))
    with TestClient(app) as c:
        yield c


# --- 基本のエンドポイント --------------------------------------------------


def test_health(client):
    res = client.get("/health")

    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_greet_default(client):
    res = client.get("/greet/audeo")

    assert res.status_code == 200
    assert res.json() == {"greeting": "やあ、audeo。"}


def test_greet_polite(client):
    res = client.get("/greet/audeo", params={"polite": True})

    assert res.status_code == 200
    assert res.json() == {"greeting": "はじめまして、audeo さん。"}


def test_echo(client):
    res = client.post("/echo", json={"message": "ping", "repeat": 3})

    assert res.status_code == 200
    assert res.json() == {"message": "pingpingping", "length": 12}


def test_echo_defaults_repeat_to_1(client):
    res = client.post("/echo", json={"message": "ping"})

    assert res.json() == {"message": "ping", "length": 4}


@pytest.mark.parametrize(
    "body",
    [
        {"message": "", "repeat": 1},  # 空文字は min_length=1 に反する
        {"message": "ping", "repeat": 0},  # repeat の下限は 1
        {"message": "ping", "repeat": 6},  # repeat の上限は 5
        {"repeat": 1},  # message が無い
    ],
)
def test_echo_rejects_invalid_body(client, body):
    """検証エラーは FastAPI が 422 で返す（自分で書いた検証コードは無い）。"""
    res = client.post("/echo", json=body)

    assert res.status_code == 422


# --- JSON ファイルによる状態 ------------------------------------------------


def test_state_starts_at_zero(client):
    res = client.get("/state")

    assert res.status_code == 200
    assert res.json() == {"counter": 0}


def test_increment_updates_state(client):
    client.post("/state/increment")
    client.post("/state/increment", json={"step": 5})

    assert client.get("/state").json() == {"counter": 6}


def test_state_survives_a_new_client(client, tmp_path):
    """状態はファイルに書かれているので、クライアントを作り直しても残る。

    = サーバを再起動しても状態が消えない、ということの確認。
    """
    client.post("/state/increment", json={"step": 3})

    with TestClient(app) as fresh_client:
        assert fresh_client.get("/state").json() == {"counter": 3}

    assert (tmp_path / "state.json").exists()


def test_reset_state(client):
    client.post("/state/increment", json={"step": 10})

    res = client.post("/state/reset")

    assert res.json() == {"counter": 0}
    assert client.get("/state").json() == {"counter": 0}
