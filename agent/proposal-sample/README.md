# 顧客提案ジェネレーター（ADK 学習用）

Gemini 3.5 系 + Google ADK で、**サブエージェント**と**Toolエージェント**を使い、
BigQuery / GCS を疑似化した環境で「顧客への提案を生成 → 確認/修正 → 承認して書き戻し」を体験する学習用プロジェクト。

> 📘 **詳しい解説（教材）**: [docs/TUTORIAL.md](docs/TUTORIAL.md) — 設計思想の全体解説。
> 🔬 **逐行解説（詳細版）**: [docs/CODE_WALKTHROUGH.md](docs/CODE_WALKTHROUGH.md) — ソースを行・ブロック単位で解説。
> 🗺️ **進捗と次の作業**: [docs/ROADMAP.md](docs/ROADMAP.md)

## 何を学べるか

| 要素 | 実装箇所 |
|---|---|
| LlmAgent（Gemini 3.5） | `proposal_app/agent.py` ほか |
| **Toolエージェント**（agent-as-tool） | root が `analyst` を `AgentTool` で呼ぶ |
| **サブエージェント**（transfer/委譲） | root が `proposal_writer` に委譲 |
| **Tool（関数ツール）** | `proposal_app/tools.py` |
| **構造化出力**（`output_schema`） | `proposal_app/schemas.py`（`ProposalOut`） |
| **ストリーミング（SSE）＋思考(thinking)表示** | `server/pipeline.py` / `server/main.py` |
| **LLM-as-judge 評価** | `server/evaluator.py` / `eval/run_eval.py` |
| BQ 読み取り／書き戻し | `list_customers` / `write_proposal_to_bq`（`store.py`=インメモリで疑似化） |
| GCS 一時保存／読み出し | `save_draft_to_gcs` / `load_draft_from_gcs`（`store.py`=インメモリで疑似化） |

## アーキテクチャ

動かし方は2通りありますが、**データ層は共通**で `proposal_app/store.py`（`mock/db.json` を seed にした
**インメモリ・ストア**）です。以前は json-server(:3000) を別立てしていましたが、**現在は store.py に取り込み済みで
json-server は不要**です。

```
[A] adk web（ADK 開発UI）
  Orchestrator (root_agent, LlmAgent)
    ├─ AgentTool(analyst)          … Toolエージェント：顧客データを分析
    ├─ sub_agent(proposal_writer)  … サブエージェント：提案文を作成
    └─ FunctionTools:
         list_customers / save_draft_to_gcs / load_draft_from_gcs / write_proposal_to_bq

[B] FastAPI ダッシュボード（server/ :8000, 1プロセス）
  web/（3ペインUI, 依存ゼロ）── 同一オリジンの /api/... を呼ぶ（CORS不要）
    └─ server/main.py（UI配信 + データAPI + 生成/再提案/対話/評価/承認/削除）
         └─ server/pipeline.py:
              ・生成/再提案: SequentialAgent(analyst_web → proposal_writer_web) を Runner で実行
                提案は output_schema(ProposalOut) で構造化JSONとして受け取る（一方向フロー）
              ・対話: proposal_chat（output_schema なし＝質問を返せる）を Runner で実行
                要件が揃うと emit_proposal ツールで構造化JSONを確定（会話型）

データ層（両モード共通）: proposal_app/store.py（mock/db.json を seed にしたインメモリ）
  customers / products / purchases … BQ 読み取り相当
  drafts                            … GCS 一時保存相当
  proposals / versions              … BQ 書き戻し・版履歴相当
```

Tool の中身（または `store.py`）を本物の `google-cloud-bigquery` / `google-cloud-storage` / Firestore に
差し替えれば、そのまま実環境化できます。

## セットアップ

### 1. 依存インストール（初回のみ）

```bash
py -3.14 -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt
```

### 2. 環境変数

`proposal_app/.env.example` を `proposal_app/.env` にコピーして調整します。

```bash
cp proposal_app/.env.example proposal_app/.env
```

`GEMINI_MODEL` は実在するモデルIDに合わせてください（下の「モデルIDの確認」参照）。

### 3. 本物の Gemini を使うための認証（初回のみ・要ブラウザ）

```bash
gcloud auth application-default login
```

---

# 動かし方A：ADK 開発UI（`adk web`）

エージェントの連携（**Toolエージェント**／**サブエージェント**）を対話で確認するモード。
データ層は `store.py`（インメモリ）なので **json-server などの別プロセスは不要**です。

```bash
./.venv/Scripts/adk.exe web
```

ブラウザで表示される URL（既定 http://localhost:8000 ）を開き、アプリ `proposal_app` を選択。
チャットに次のように入力して動作を確認します。

```
顧客ID C002 の提案を作って
```

期待する流れ：
1. `analyst`（Toolエージェント）が C002 を分析
2. `proposal_writer`（サブエージェント）が提案（title/body/推奨商品）を作成
3. `save_draft_to_gcs` で下書き保存（draft_id が返る）
4. 「承認します」と伝えると `write_proposal_to_bq` でBQ相当に書き戻し

`store.py`（インメモリ）の `drafts` / `proposals` に結果が追記されれば成功です
（データは同一プロセス内。プロセス再起動で `mock/db.json` の初期状態に戻ります）。

## モデルIDの確認

`gemini-3.5-flash` が使えない場合は、利用可能な生成モデルIDに合わせて `.env` の
`GEMINI_MODEL` を変更してください（例: `gemini-3.5-pro` など）。
モデル未存在なら 404 系のエラーが出るので、その場合に切り替えます。

---

# 動かし方B：独自ダッシュボードUI（FastAPI・推奨）

`adk web`（開発用UI）とは別に、**エンドユーザー向けの独自ダッシュボード**を用意しています。
BQデータの一覧表示 → 顧客選択 → エージェントが提案生成 → 確認/修正 → 承認でBQ書き戻し、を1画面で行えます。
**1コンテナ・1プロセス**（json-server は不要）。

## 起動（ターミナル1つ）

`adk web` とはポート(:8000)が競合するので、同時に起動しないでください。

```powershell
./.venv/Scripts/python.exe -m uvicorn server.main:app --port 8000 --reload
```

ブラウザで **http://localhost:8000** を開く → 顧客を選ぶ → 「✨ 提案を生成」→ 内容を確認/修正 →
「✅ 承認してBQに書き戻す」。`store.py`（インメモリ）の `drafts`/`proposals` に結果が入ります。

> `--port 8000` が使えない場合は任意のポート（例 `--port 8080`）でOK。UIは同一オリジンを見るので変更不要です。

## ダッシュボードの主な機能

- **分析→提案生成（SSEストリーミング）**: 分析テキストとモデルの**思考(thinking)**をライブ表示（`/api/generate_stream`）。
- **モデルの思考プロセス表示**: `analyst` と `proposal_writer` の**両方**が思考を出力。**分析結果の下に既定で開いて**表示し、
  **会話の流れの各ターン（初回生成／各再提案）にもそのターンの思考を折りたたみで併記**。
  ※思考の言語は日本語をプロンプトで誘導しているが、Gemini の thinking は言語制御が効きにくく英語のことが多い。
- **指示して再提案（会話継続）**: 過去の指示を記憶。再提案も**SSEでライブ表示**（`/api/refine_stream`）。
- **エージェントと相談して作成（対話・往復）**: チャットでやりとりしながら要件を固める（`/api/chat_stream`）。
  対話用エージェントは `output_schema` で縛らないため**情報が足りなければ質問を返し**、条件が揃うと
  `emit_proposal` ツールで提案を確定して右のフォームに反映（下書き保存＋版履歴 `対話` を記録）。
  生成/再提案（一方向フロー）に対する**会話型**の入口で、確定後は評価・承認・履歴の導線にそのまま乗る。
- **モデル稼働中のフロート表示**: 画面固定のスピナー＋ステータス。スクロール位置に関係なく「動いている」ことが分かる。
- **版管理（生成履歴）**: 生成/再提案ごとに版を記録し、**復元**・**2版比較**。既定は折りたたみ。
- **インライン評価（🧪）**: LLM-as-judge で grounding / relevance / actionability を採点（`/api/evaluate`）。
- **保存済み提案・履歴の削除**、**カラーテーマ**（Light/Dark/System）。
- **商品選択のDnD**: 商品画像パレット→メールプレビューへドラッグで追加/並べ替え/削除。
- **モバイル「PC版で表示」トグル**: 小さい画面でデスクトップ版（固定幅）を縮小表示。

## 主なAPI（`server/main.py`）

| メソッド・パス | 用途 |
|---|---|
| GET `/api/customers` `/api/customers/{id}` `/{id}/purchases` `/api/products` | データ参照 |
| GET `/api/proposals?customer_id=` `/api/versions?customer_id=` | 保存済み提案 / 生成履歴 |
| POST `/api/generate` / `/api/generate_stream`(SSE) | 提案生成（非ストリーム / ストリーム） |
| POST `/api/refine` / `/api/refine_stream`(SSE) | 再提案（非ストリーム / ストリーム。会話継続） |
| POST `/api/chat_stream`(SSE) | 対話（往復）。質問が返ることもあり、確定時のみ提案を返す（`reset` で会話リセット） |
| POST `/api/evaluate` | LLM-as-judge 採点 |
| POST `/api/approve` | 承認して保存（proposal_id 有=更新 / 無=新規） |
| DELETE `/api/proposals/{id}` `/api/versions/{id}` | 削除 |

## トラブルシュート

- **顧客が取得できない / Tool がエラー** → データは `store.py`（同一プロセス・インメモリ）。`mock/db.json` が読めるか確認。
  （json-server は不要になりました。以前の :3000 は使いません）
- **認証エラー（401/403）** → `gcloud auth application-default login` と `.env` の `GOOGLE_CLOUD_PROJECT` を確認。
- **モデルが見つからない（404）** → `.env` の `GEMINI_MODEL` を実在IDに変更。
- **`address already in use`（EADDRINUSE / 8000使用中）** → `adk web` など既存プロセスを停止するか、別ポートで起動。
  ```powershell
  Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  ```

## 評価（Eval）

提案品質を自動評価するハーネスがあります（Gemini 課金あり）。詳細は [eval/README.md](eval/README.md)。

```bash
./.venv/Scripts/python.exe eval/run_eval.py
```

---

# デプロイ（Cloud Run）

Cloud Run 向けに **1コンテナ・1プロセス**化しています（json-server は廃止し、データ層は
`proposal_app/store.py` に取り込み）。データはインメモリのため、再デプロイやスケールで
初期状態(`mock/db.json`)に戻ります（永続化したい場合は store.py を GCS/Firestore/BQ に差し替え）。

> ⚠️ **git push とデプロイは別物**。コードを変えても Cloud Run は自動更新されません。
> **本番に反映するには毎回 `gcloud run deploy` が必要**です。

前提: 必要なAPI（run / cloudbuild / artifactregistry / aiplatform）は有効化済み。

### 1. Cloud Run 実行SAに Vertex 権限を付与（初回のみ）

```bash
gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

### 2. デプロイ（`agent` ディレクトリで実行）

`APP_PASSWORD` は自分で決めた強めのパスワードに置き換えてください（サイト全体に Basic 認証）。

```bash
gcloud run deploy proposal-app --source . --project your-project-id --region asia-northeast1 \
  --allow-unauthenticated --concurrency=3 --max-instances=1 --memory=512Mi --cpu=1 \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=your-project-id,GOOGLE_CLOUD_LOCATION=global,GEMINI_MODEL=gemini-3.5-flash,APP_PASSWORD=CHANGE-ME
```

- 完了すると `https://proposal-app-xxxxx.asia-northeast1.run.app` のような URL が表示されます。
- ブラウザで開くと Basic 認証のダイアログが出ます（ユーザー名は任意、パスワードは `APP_PASSWORD`）。
- `--allow-unauthenticated` は「URLに到達可能」にするだけで、実際のアクセス制限は `APP_PASSWORD` が担います。

### 独自ドメイン（任意）

`*.run.app` が会社ネットワーク等で遮断される場合、独自ドメインを割り当てると回避できることがあります。

```bash
gcloud beta run domain-mappings create --service proposal-app \
  --domain <sub.example.com> --project your-project-id --region asia-northeast1
```
表示された DNS レコード（サブドメインは通常 CNAME → `ghs.googlehosted.com.`）を DNS に登録し、証明書発行を待ちます。

### メモ / 次の一手
- **課金**: 開くたびに本物の Gemini を呼ぶため、パスワードは必ず設定を。
- **最小インスタンス**: コールドスタートを避けたいなら `--min-instances=1`（その分コスト増）。
- **休止/再開**: `run services remove/add-iam-policy-binding ... --member=allUsers --role=roles/run.invoker`（反映に1〜2分）。
- **データ永続化**: `store.py` を GCS 上の JSON（`gs://bucket/db.json`）読み書き等に変えると再起動でも保持。
