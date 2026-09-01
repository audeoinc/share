"""TestClient で API を呼び、リクエストとレスポンスを画面に出すだけのスクリプト。

pytest は「期待どおりか」を確認するものなので、成功しても中身は見えない。
こちらは「実際に何が返ってきているか」を目で見るためのもの。

実行:
    python demo.py
"""
from __future__ import annotations

import json
import os
import tempfile

from fastapi.testclient import TestClient


def show(res) -> None:
    """1 回の呼び出しの結果を見やすく表示する。"""
    body = json.dumps(res.json(), ensure_ascii=False)
    print(f"  {res.request.method:6} {res.request.url.path:20} -> {res.status_code}  {body}")


def main() -> None:
    # 状態ファイルは一時ディレクトリへ。何度実行しても 0 から始まる。
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["CONTENT_API_STATE_FILE"] = os.path.join(tmp, "state.json")

        from app.main import app  # 環境変数を設定してから import する

        with TestClient(app) as client:
            print("\n[1] 基本のエンドポイント")
            show(client.get("/health"))
            show(client.get("/greet/audeo"))
            show(client.get("/greet/audeo", params={"polite": True}))
            show(client.post("/echo", json={"message": "ping", "repeat": 3}))

            print("\n[2] 入力が不正なとき（FastAPI が自動で 422 を返す）")
            show(client.post("/echo", json={"message": "ping", "repeat": 99}))

            print("\n[3] JSON ファイルで持つ状態")
            show(client.get("/state"))
            show(client.post("/state/increment"))
            show(client.post("/state/increment", json={"step": 5}))
            show(client.get("/state"))

            print("\n[4] クライアントを作り直しても状態は残る（＝再起動しても消えない）")
        with TestClient(app) as fresh_client:
            show(fresh_client.get("/state"))

        print("\n[5] 実際に書かれているファイルの中身")
        with open(os.environ["CONTENT_API_STATE_FILE"], encoding="utf-8") as f:
            print("  " + f.read().replace("\n", "\n  "))


if __name__ == "__main__":
    main()
