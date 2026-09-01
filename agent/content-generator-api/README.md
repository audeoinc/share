# Content Generator API — サンプル（第一歩）

コンテンツジェネレーターを **開始 / 中断 / 再開** できる API を作る、その一歩目。
ここでは「FastAPI で API を書く」「TestClient で呼び出しと応答を確認する」
「状態を JSON ファイルで持つ」の 3 点だけを、動く形で確認する。

## 構成

```
agent/content-generator-api/
├── app/
│   ├── main.py         # FastAPI 本体（エンドポイント定義）
│   └── state_store.py  # JSON ファイルへの状態の読み書き
├── tests/
│   └── test_main.py    # TestClient によるテスト
├── demo.py             # 呼び出しと応答を画面に出すデモ
└── requirements.txt
```

## 準備

```bash
cd agent/content-generator-api
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 1. まず動くところを見る

```bash
python demo.py
```

TestClient で API を順に呼び、リクエストとレスポンスをそのまま表示する。
出力例:

```
[1] 基本のエンドポイント
  GET    /health              -> 200  {"status": "ok"}
  GET    /greet/audeo         -> 200  {"greeting": "やあ、audeo。"}
  POST   /echo                -> 200  {"message": "pingpingping", "length": 12}

[2] 入力が不正なとき（FastAPI が自動で 422 を返す）
  POST   /echo                -> 422  {"detail": [{"type": "less_than_equal", ...}]}

[3] JSON ファイルで持つ状態
  GET    /state               -> 200  {"counter": 0}
  POST   /state/increment     -> 200  {"counter": 1}
  POST   /state/increment     -> 200  {"counter": 6}

[4] クライアントを作り直しても状態は残る（＝再起動しても消えない）
  GET    /state               -> 200  {"counter": 6}
```

## 2. テストを実行する

```bash
pytest -v
```

`TestClient` は **uvicorn を起動せずに** FastAPI アプリへ直接リクエストを投げる。
サーバの起動待ちもポートの確保も要らないので速く、CI でもそのまま動く。

状態ファイルは `CONTENT_API_STATE_FILE` 環境変数で差し替えられるようにしてあり、
テストでは pytest の `tmp_path` を指すため、実データを汚さない。

## 3. 本物のサーバとして起動する

```bash
uvicorn app.main:app --reload --port 8000
```

- http://127.0.0.1:8000/docs — 自動生成された画面。ブラウザから各 API を試せる
- http://127.0.0.1:8000/health — 疎通確認

## エンドポイント一覧

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/health` | 疎通確認 |
| GET | `/greet/{name}?polite=true` | パス/クエリパラメータの受け取り方 |
| POST | `/echo` | リクエスト本文の受け取りと検証 |
| GET | `/state` | JSON ファイルの状態を読む |
| POST | `/state/increment` | 状態を更新する（`{"step": 5}`） |
| POST | `/state/reset` | 状態を初期化する |

## 状態の持ち方（DB を使わない）

`app/state_store.py` が JSON ファイル 1 枚を読み書きするだけ。

- 保存先は既定で `data/state.json`。`CONTENT_API_STATE_FILE` で変更できる
- 書き込みは「一時ファイルへ書く → `os.replace` で置き換える」。
  途中で落ちても壊れた JSON が残らない
- 1 プロセス内の同時更新に備えて `threading.Lock` を持つ

この先ジョブ管理へ進んでも、**保存するデータの形が変わるだけで仕組みは同じ**。

## 次のステップ（ゴールに向けて）

ここで確認した形をそのまま広げていく。

1. 状態を「カウンタ」から「ジョブ」に置き換える
   ```json
   {
     "jobs": {
       "job_01": {
         "status": "running",          // pending / running / paused / done / failed
         "topic": "新製品の紹介記事",
         "progress": {"done": 3, "total": 10},
         "chunks": ["第1章 ...", "第2章 ...", "第3章 ..."],
         "updated_at": "2026-09-01T10:00:00"
       }
     }
   }
   ```
2. エンドポイントを揃える
   - `POST /jobs` — 開始（ジョブを作って `running` に）
   - `GET /jobs` / `GET /jobs/{job_id}` — 一覧・進捗の確認
   - `POST /jobs/{job_id}/pause` — 中断（`running` → `paused`）
   - `POST /jobs/{job_id}/resume` — 再開（`paused` → `running`、続きから生成）
   - `DELETE /jobs/{job_id}` — 破棄
3. 状態遷移の規則を決める（例: `done` のジョブは再開できない → 409 を返す）
4. 生成処理そのものをつなぐ（中断できるよう、1 チャンクごとに状態を保存する）
