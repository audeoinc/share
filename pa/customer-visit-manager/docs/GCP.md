# CCP の GCP 版(Cloud Run + Cloud SQL + Gemini)

Power Apps 版と**同じ画面のコード**を、GCP でも動かす仕組み。方針・進み具合・使い方をまとめる。
**このリポジトリは公開**なので、プロジェクト ID・URL・パスワードは、ここにも書かない(`<…>` で示す)。

## 方針(決定済み)

- 営業支援システム(`proposal-app`)と**同じ GCP プロジェクト・リージョン(東京)・実行サービスアカウント**の、**別の Cloud Run サービス**(`contents-planner`)。
- アクセスは **HTTP Basic 認証**(環境変数 `APP_PASSWORD`。ユーザーの識別はしない)。環境は本番(PRD)1 つ。
- サーバーは **Python / FastAPI**。DB は **Cloud SQL(PostgreSQL)**。画像は **GCS**。
- AI は **Vertex AI の Gemini**(`google-genai` SDK で直接呼ぶ。ADK は使わない)。プロンプト・JSON の解釈・リトライは**画面側(TypeScript)に残し**、Power Apps 版と共有する。
- **データは Power Apps 版(Dataverse)と別**。同じ初期データから始める。同期するのは「コードと機能」。
- DB は**普段は停止**。アクセス時に自動で起動(画面に「準備中」)、最後のアクセスから 30 分で自動停止(Cloud Scheduler)。

## 2 つのビルドを同期させる仕組み

画面のコード(`src/`)は 1 本。ビルドの設定だけが違う。

| | Power Apps 版 | GCP 版 |
|---|---|---|
| 設定 | `vite.config.ts` | `vite.gcp.config.ts` |
| データの入出力 | 生成された `Cr854_…Service`(Dataverse) | `src/gcp/services.ts`(`/api/data` を呼ぶ互換サービス) |
| AI | `airequest` テーブル + Power Automate + Copilot Studio | `src/gcp/ai.ts` が、同じ呼び出しを `/api/ask`(Vertex AI の Gemini)に置き換える |
| 出力 | `dist/` | `dist-gcp/` |

- GCP 版は、`generated/services/*` の import を、ビルド時に互換サービスへ差し替える(撮影用のモックと同じ手法)。**画面側に、GCP 用の分岐は入れない**。
- `npm run verify` は、両方のビルドと、データ定義の突き合わせ(下)を行う。CI も同じ。

## データ定義(`server/schema.json`)

Dataverse の名前(画面が使う `cr854_scheduledat`、`_cr854_heroimage_value`)と、PostgreSQL の読みやすい名前(`scheduled_at`、`hero_image_id`)の**対応表**。これが唯一の正で、次の 3 つを作る。

1. テーブルを作る SQL(`python -m ccp.cli migrate`)
2. API の名前・値の変換(サーバーが、画面には従来どおりの Dataverse の形で返す)
3. 触ってよいテーブル・列の許可リスト(それ以外は 400)

**Dataverse に列を足したら**: `pa app add data-source …` で生成し直す → `server/schema.json` にも追記 → `npm run verify`(`scripts/check-schema.mjs` が、食い違いを検出する)→ DB には `migrate` で反映。

選択肢の値は、Dataverse と同じ数値(例: 588230000)のまま `integer` で持つ。

## `/api/data`(サーバー)

`GET/POST /api/data/{テーブル}`、`GET/PATCH/DELETE /api/data/{テーブル}/{id}`。テーブル名は Dataverse の名前(`cr854_deliverycards`)。
戻り値は `{success, data}` / `{success:false, error:{message, code?}}`(Power Apps SDK と同じ形)。

- 絞り込み(`filter`): `項目 eq 値` を `and` でつなぐ範囲(`eq/ne/gt/ge/lt/le`、`null`)。値は必ずパラメータとして渡す。
- 並べ替え(`orderBy`)、`select`、`top`、`skip`。
- 書き込みの参照は、Dataverse と同じ `cr854_xxx@odata.bind: "/cr854_yyys(<id>)"`(`null` で参照を外す)。
- DB に接続できないときは 503 + `code: "db_unavailable"`。

## AI(`/api/ask`)

- 画面側の `askAgent`(プロンプトの作成・JSON の解釈・やり直し・チャット・英語化)は、**Power Apps 版と共通のまま**。差し替えるのは、依頼文を送って返答のテキストを受け取る部分だけ(`src/gcp/ai.ts`)。
- サーバーは、依頼文を Gemini に渡して、返答のテキストをそのまま返す(`server/ccp/ai.py`)。返答は JSON 形式で出力させる。
- 設定(環境変数。営業支援システムと同じ Vertex AI): `GOOGLE_CLOUD_PROJECT`(コードには書かない)、`GOOGLE_CLOUD_LOCATION`(既定 global)、`GEMINI_MODEL`(既定 gemini-3.5-flash)、`GEMINI_THINKING`(minimal / low / medium / high。既定 low)。
- 1 回の「すべてAIで下書き」は、手元の確認で約 40 秒(Power Apps 版の、フロー経由のポーリングより速い)。

## 手元での動かし方

必要なもの: Python 3.12 以上、Node、`gcloud`(ログイン済み)。

```bash
# 1. サーバーの環境(初回だけ)
cd server && python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt

# 2. 接続の設定(値は、手元の環境変数。リポジトリには置かない)
#    CLOUD_SQL_INSTANCE=<プロジェクトID>:<リージョン>:<インスタンス名>
#    DB_PASSWORD=<Secret Manager のアプリ用パスワード>
#    APP_PASSWORD=<Basic 認証のパスワード。手元では任意>
#    GOOGLE_CLOUD_PROJECT=<プロジェクトID>   ← AI(Vertex AI)用
#    CCP_DEV_GCLOUD=1   ← 手元だけ。gcloud の短期トークンで Cloud SQL / Vertex AI に接続する
# 別の PostgreSQL を使うなら DATABASE_URL=postgresql+asyncpg://user:pass@host/db

# 3. テーブルの作成と初期データ(DB が起動している間に)
.venv/Scripts/python.exe -m ccp.cli migrate
.venv/Scripts/python.exe -m ccp.cli seed --reset      # server/seed.json を入れる
.venv/Scripts/python.exe -m ccp.cli counts

# 4. 画面をビルドして、サーバーを起動(http://localhost:8080 。Basic 認証のユーザー名は何でもよい)
npm run build:gcp
cd server && .venv/Scripts/python.exe -m uvicorn ccp.main:app --port 8080

# 動作確認(画面を開いて、カードを開けるかを見る)
CCP_PASSWORD=<APP_PASSWORD> node scripts/gcp-smoke.mjs
#   CCP_SMOKE_AI=1    … テーマ案を、実際に Gemini に頼む(費用がかかる)
#   CCP_SMOKE_AI=full … 空のカードを開いて、すべて AI で下書きさせる(約 40 秒。保存はしない)
```

画面を直しながら動かすときは、サーバーを 8080 で起動したまま `npm run dev:gcp`(5191。`/api` は 8080 に中継)。

初期データ(`server/seed.json`)は、撮影用のモックと同じ元データ(`docs/*.csv` → `src/mock/seed.ts`)から作る。`seed.ts` を直したら `npm run seed:export` で書き出し、`seed.json` もコミットする。

## テスト

- `python -m unittest discover server/tests`(DB に接続しない。名前・値の変換と、絞り込みの解析)
- `node scripts/check-schema.mjs`(データ定義と生成モデルの突き合わせ)
- `node scripts/gcp-smoke.mjs`(サーバーと DB をつないだ画面の確認)

## 進み具合

| 段階 | 内容 | 状態 |
|---|---|---|
| 0 | Cloud SQL・GCS バケットの作成(DB は停止状態で運用) | 完了 |
| 1 | データ層(定義・変換・`/api/data`・互換サービス・初期データ) | 完了(手元のサーバー + Cloud SQL で確認) |
| 2 | AI(`/api/ask` → Gemini、画面側の差し替え) | 完了(手元で、テーマ案・すべて AI で下書きまで確認) |
| 3 | Cloud Run へのデプロイ・Basic 認証・画像(GCS)・DB の自動起動/停止 | 未着手 |
| 4 | 両ビルドの契約テスト・CI の拡充 | 一部(`verify` と CI に、GCP ビルド・データ定義の突き合わせ・サーバーのテストを追加済み) |
