# HTML フロント構成で Gemini Enterprise agent platform は使えるか

**結論から言うと、使えます。** Gemini Enterprise app（プロンプトベースのノーコード app）を経由する必要はなく、
自前の HTML フロント + Python バックエンドから agent platform のモデル API を直接呼べます。
さらにその構成のほうが、**Google にデータを学習利用されない**状態を明示的に担保しやすくなります。

- 対象読者: 現在 Gemini Enterprise app を利用していて、自前 Web アプリ化を検討している関係者
- 参照した公式ドキュメント: [Google AI から Gemini Enterprise agent platform への移行](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai?hl=ja)

---

## 1. 結論（4行）

| # | 論点 | 結論 |
|---|---|---|
| 1 | Gemini で推論させるのに Gemini Enterprise app は必須か | **必須ではない。** app は「UI とオーケストレーションを提供する製品の一形態」であって、推論そのものは agent platform のモデル API が担う。API を直接叩けば app は不要 |
| 2 | Web サーバ内の Python から使えるか | **使える。** Google Gen AI SDK（`google-genai`）/ ADK をサーバ側で呼ぶだけ。HTML フロントは自前サーバの `/api/...` を叩き、Gemini とは直接通信しない |
| 3 | 認証はどうするか | **GCP 内のコンポーネント同士ならサービスアカウントで完結。** Cloud Run に付けたサービスアカウントの資格情報（ADC）で、Gemini 呼び出しも BigQuery アクセスも通る。API キーは発行も配布も不要 |
| 4 | Google にデータを使われないか | **agent platform 側（= Cloud 側）を使う限り、顧客データはモデルの学習・製品改善に利用されない。** これが Google AI（Gemini Developer API / API キー経路）との最大の差 |

> つまり「Gemini Enterprise app をやめると Gemini が使えなくなる」わけではなく、
> **app をやめて自前 HTML + Python にしたほうが、データ境界は締めやすくなる**、というのが全体像です。

### 全体構成（目標形）

```
[ブラウザ]
   HTML / CSS / JS（静的ファイル）
        │  同一オリジンの fetch("/api/generate")     ← ここに API キーは一切置かない
        ▼
[Cloud Run コンテナ] ← サービスアカウントを割り当て
   Python (FastAPI / Flask)
        ├─ google-genai / ADK ──► Gemini Enterprise agent platform（モデル推論）
        └─ google-cloud-bigquery ─► BigQuery（社内データ）
        認証はすべて ADC（= 割り当てたサービスアカウント）。鍵ファイルなし
```

ポイントは **ブラウザから Gemini を直接呼ばない**ことです。直接呼ぶと API キーをクライアントに置くことになり、
キー漏洩・課金事故・データ経路の説明不能という三重の問題が出ます。サーバ経由なら全部消えます。

---

## 2. Gemini Enterprise app は推論の必須経路ではない

### 2.1 レイヤーの整理

混同されやすいので、名前を分けて整理します。

| 名称 | 実体 | 今回の位置づけ |
|---|---|---|
| **Gemini Enterprise app** | 管理コンソール上でプロンプト・データソース・ツールを設定して作る、ノーコード/ローコードのアプリ（旧 Agentspace 系の UI） | **今使っているもの。今回は経由しない** |
| **Gemini Enterprise agent platform** | モデル API・エージェント実行基盤（旧 Vertex AI）。`generateContent` などの API を提供 | **これを直接使う** |
| **Google AI / Gemini Developer API** | API キーで叩ける開発者向けエンドポイント（AI Studio 系） | **使わない**（データ利用条件が異なるため。第4章） |

app は agent platform の上に乗っている利用形態のひとつであり、**app を通らないとモデルが使えないという依存関係はありません。**
自前アプリからは agent platform を直接呼びます。

### 2.2 コード例：Python から agent platform を呼ぶ

Google Gen AI SDK は、Google AI 側と agent platform 側の**両方に同じコードで繋がります**。差はクライアントの初期化だけです。

```python
# pip install google-genai
from google import genai

# ── agent platform（Vertex 系）を使う。これが今回採用する経路 ──────────────
client = genai.Client(
    vertexai=True,                       # ← ここが分岐点
    project="your-project-id",
    location="asia-northeast1",          # リージョンを明示（第5章）
)

resp = client.models.generate_content(
    model="gemini-3.5-flash",
    contents="この顧客への提案を作成してください: ...",
)
print(resp.text)
```

比較のため、**採用しない**ほうの書き方も載せます。

```python
# ── Google AI（Gemini Developer API）。API キー経路。今回は使わない ────────
client = genai.Client(api_key="AIza...")   # ← キーの配布・保管・ローテーションが必要になる
```

環境変数で切り替えることもできます（コードに project を書かずに済むので、Cloud Run ではこちらが実用的）。

```bash
GOOGLE_GENAI_USE_VERTEXAI=TRUE
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=asia-northeast1
```

```python
from google import genai
client = genai.Client()   # 上記の環境変数を自動で読む
```

### 2.3 コード例：HTML フロントに繋ぐ（FastAPI）

フロントは自前サーバの API を叩くだけです。CORS も不要（同一オリジン）、認証情報もブラウザに出ません。

```python
# server/main.py
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from google import genai

app = FastAPI()
client = genai.Client()          # ADC + 環境変数で agent platform に接続

class Req(BaseModel):
    customer_id: str

@app.post("/api/generate")
def generate(req: Req):
    rows = fetch_customer_from_bq(req.customer_id)     # ← 第3章
    resp = client.models.generate_content(
        model="gemini-3.5-flash",
        contents=f"次の顧客データを踏まえて提案を作成: {rows}",
    )
    return {"text": resp.text}

# 静的 HTML の配信（同一オリジンにする）
app.mount("/", StaticFiles(directory="web", html=True), name="web")
```

```javascript
// web/app.js — ブラウザ側。鍵も project ID も出てこない
const res  = await fetch("/api/generate", {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify({ customer_id: "C001" }),
});
const data = await res.json();
document.querySelector("#out").textContent = data.text;
```

> **実装済みの参考例**: このリポジトリの [`agent/proposal-sample`](../agent/proposal-sample) が、まさにこの構成
> （静的 HTML + FastAPI + ADK、Cloud Run に `GOOGLE_GENAI_USE_VERTEXAI=TRUE` でデプロイ）で動いています。
> 「HTML フロントから agent platform が使えるか」の実証としてそのまま提示できます。

---

## 3. GCP 内のコンポーネント同士はサービスアカウントで完結する

Cloud Run（アプリ）→ Gemini / BigQuery は、いずれも **同じサービスアカウントの資格情報（ADC）**で認証されます。
サービスアカウントの JSON 鍵ファイルを作る必要はありません（作らないほうが安全です）。

### 3.1 コマンド例：サービスアカウントと権限

```bash
PROJECT=your-project-id
SA=proposal-app-sa

# 1) サービスアカウントを作る
gcloud iam service-accounts create "$SA" \
  --display-name="Proposal app runtime" --project="$PROJECT"

SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"

# 2) Gemini（agent platform）を呼ぶ権限
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user"

# 3) BigQuery を読む権限（クエリ実行 + データ参照）
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.jobUser"

# データ参照はデータセット単位に絞るのが望ましい（プロジェクト全体に付けない）
bq add-iam-policy-binding \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/bigquery.dataViewer" \
  "${PROJECT}:your_dataset"
```

### 3.2 コマンド例：Cloud Run にサービスアカウントを割り当ててデプロイ

```bash
gcloud run deploy proposal-app \
  --source . \
  --project="$PROJECT" \
  --region=asia-northeast1 \
  --service-account="$SA_EMAIL" \
  --set-env-vars=GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=asia-northeast1,GEMINI_MODEL=gemini-3.5-flash
```

これで、**コンテナ内のコードは資格情報を一切意識しません。** `genai.Client()` も
`bigquery.Client()` も、実行環境から自動でサービスアカウントの資格情報を拾います（ADC）。

```python
# BigQuery も同じ資格情報でそのまま通る
from google.cloud import bigquery

bq = bigquery.Client()      # 鍵ファイルなし。Cloud Run のサービスアカウントで認証される

def fetch_customer_from_bq(customer_id: str):
    sql = """
        SELECT customer_id, name, plan, mrr
        FROM `your-project-id.your_dataset.customers`
        WHERE customer_id = @cid
    """
    job = bq.query(
        sql,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("cid", "STRING", customer_id)]
        ),
    )
    return [dict(r) for r in job.result()]
```

### 3.3 ローカル開発時

開発者の PC には Cloud Run のサービスアカウントがないので、自分の Google アカウントを ADC として使います。

```bash
gcloud auth application-default login
gcloud config set project your-project-id
```

コードは変更不要です。**ローカルも本番も同じコードのまま**動きます。

---

## 4. データ利用の比較（Google AI と agent platform）

「Google にデータを使われるかどうか」は、**どちらのエンドポイントを使うかで決まります。**
以下は公式ドキュメントの比較表からの抜粋です。

**出典**: [Google AI から Gemini Enterprise agent platform への移行 — Google Cloud ドキュメント](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai?hl=ja)

| 観点 | Google AI（Gemini Developer API） | Gemini Enterprise agent platform |
|---|---|---|
| **想定用途** | プロトタイピング・個人開発 | 本番運用・エンタープライズ |
| **認証** | **API キー** | **IAM / Application Default Credentials（サービスアカウント）** |
| **鍵の管理** | キーの発行・配布・保管・ローテーションが必要 | 鍵ファイル不要。IAM ロールで制御 |
| **データの学習利用** | **無料枠ではプロンプト・応答が製品改善に利用される**（有料枠では利用されない） | **顧客データはモデルの学習・製品改善に利用されない** |
| **アクセス制御の粒度** | キー単位（実質オール・オア・ナッシング） | IAM ロール／プリンシパル単位、リソース単位 |
| **リージョン指定・データレジデンシー** | 限定的 | リージョンを指定可能（例: `asia-northeast1`） |
| **VPC Service Controls** | 非対応 | 対応（データ持ち出し境界を設定可能） |
| **CMEK（顧客管理の暗号鍵）** | 非対応 | 対応 |
| **監査ログ** | なし | Cloud Audit Logs に記録される |
| **他 GCP サービスとの連携** | 個別に実装が必要 | BigQuery / GCS / Cloud Run などとネイティブに連携 |
| **SDK** | Google Gen AI SDK（`google-genai`） | **同じ SDK**（`vertexai=True` で切り替え） |
| **無料枠** | あり | なし（Cloud の課金アカウントに紐づく） |

> **注記（要確認）**: 上表は移行ドキュメントの比較表を要約したものです。契約条件・データ処理条項の正確な文言は、
> 上記 URL および Google Cloud のデータ処理規約（Cloud Data Processing Addendum）の原文で最終確認してください。
> 特に「無料枠でのデータ利用」の条件は改定されることがあります。

### この表の読み方（説明の要点）

説明の場では、次の一文に集約できます。

> **API キーで叩く Google AI 側ではなく、サービスアカウントで叩く agent platform 側を使う。
> それだけで、入力したデータが Google のモデル学習に使われる経路から外れる。**

そして第3章のとおり、自前 Web アプリ構成では **そもそも API キーを使う理由がない**（サービスアカウントのほうが楽）ので、
「安全な側を選ぶために何かを我慢する」という話にはなりません。

---

## 5. 「学習に使われない」と「痕跡が残らない」は別物

ここは説明の場で最も突っ込まれやすい箇所なので、先回りして整理します。
第4章で担保されるのは **「モデルの学習・製品改善に使われない」** ことであって、
**「データが一切どこにも記録されない」** ことではありません。両者は別の話です。

| 主張 | 何で担保されるか | 追加でやること |
|---|---|---|
| **モデルの学習に使われない** | agent platform を使うこと（Cloud のデータ処理条項） | なし（経路を選ぶだけ） |
| **データが国外に出ない** | `location` にリージョンを明示（例: `asia-northeast1`） | **`global` エンドポイントを使わない**。モデルのリージョン可用性を事前確認 |
| **プロジェクト外に持ち出せない** | VPC Service Controls でサービス境界を設定 | 境界設定と、境界越えが必要な連携の洗い出し |
| **不正利用検知のためのログ保持** | — | **要確認事項。** 濫用検知目的の一時的なログ保持が別途規定されている場合があるため、ゼロデータ保持や検知除外の適用可否を Google 側に確認する |
| **保管データの暗号鍵を自社管理** | CMEK | 鍵の運用体制 |
| **外部検索にクエリが出ない** | **グラウンディング機能の設定** | 下記参照 |

### グラウンディングの扱い（重要）

Gemini には「Google 検索によるグラウンディング（Grounding with Google Search）」があります。
**これを有効にすると、ユーザーの入力に基づくクエリが外部の検索経路に出ます。**
「社内データしか使わない・外に出さない」という説明をするなら、次のどちらかにします。

- グラウンディングを**使わない**（社内 BigQuery の値だけをプロンプトに渡す。第3章の構成がこれ）
- 使う場合は、Google 検索ではなく **社内データを対象としたグラウンディング**（Vertex AI Search / 自前の RAG）にする

現行の Gemini Enterprise app では、この種のデータソース設定が管理画面側で行われているため、
**自前アプリに移すと「何を参照しているか」がコード上で明示的になり、むしろ説明しやすくなります。**

### アプリ側のログにも注意

Google 側の話とは別に、**自分たちのアプリが入力内容を Cloud Logging に書き出していないか**は確認が必要です。
プロンプト全文を `print()` している実装は、そのまま Cloud Logging に残ります。
機微データを扱うなら、ログには ID や件数だけを出し、本文は出さない方針にします。

---

## 6. 現状（Gemini Enterprise app）からの位置づけ

| | 現状: Gemini Enterprise app | 提案: HTML + Python + agent platform |
|---|---|---|
| UI | 提供される（設定のみ） | **自前で作る**（作り込みは自由） |
| プロンプト管理 | 管理画面 | コード内・設定ファイル（Git で版管理・レビュー可能） |
| データ接続 | コネクタ設定 | **BigQuery を直接クエリ**（SQL とスキーマを自分で制御） |
| 認証 | 製品側の仕組み | サービスアカウント（GCP 内）+ フロントのユーザー認証は自前（第7章） |
| データ利用 | 製品の条件に従う | **agent platform の条件が明示的に適用される** |
| 変更容易性 | 管理画面の範囲内 | コード次第（ロジック・出力形式・評価まで作り込める） |

**両者は排他ではありません。** app は既存の用途で残したまま、
今回の Web アプリだけを agent platform 直接利用で作る、という併存が可能です。
移行というより「用途に応じた使い分け」として説明するほうが実態に合います。

---

## 7. 残論点（未決事項）

説明の場で「では次は？」となる部分です。**現時点では未決**として明示しておきます。

### 7.1 アクセス制御の粒度 ← 既存 app との差が最も出るところ

Gemini Enterprise app は、**利用者個人の ID に紐づいたアクセス制御**（誰がどのデータソースを参照できるか）を
製品側で持っています。一方、自前 HTML + Python にすると、サービスアカウントは
**アプリ全体で1つの権限**を持つため、「ユーザー A は顧客 X しか見られない」といった制御は
**アプリ側で実装する必要があります。**

検討が必要な選択肢:

- **Identity-Aware Proxy (IAP)** / Cloud Run の IAM 認証で、そもそも社内の誰がアプリを開けるかを制御する
- アプリ内でユーザーを識別し、BigQuery のクエリに絞り込み条件を入れる（行レベルの制御をアプリで担保）
- BigQuery の **行レベルセキュリティ / 承認済みビュー** を使い、DB 側で担保する
- 暫定的に Basic 認証で全体を閉じる（PoC 段階のみ。本番の答えにはしない）

**決めるべきこと**: 誰が何を見られるべきか、その制御をアプリ・BigQuery・IAP のどこで担保するか。

### 7.2 その他

| 論点 | 内容 |
|---|---|
| **リージョンとモデル可用性** | `asia-northeast1` で使いたいモデルが提供されているかを事前確認。提供されていない場合、リージョン固定とモデル選定のどちらを優先するか |
| **ログ保持・濫用検知の除外** | 第5章のとおり、要件が厳しい場合は Google 側への確認が必要 |
| **監査要件** | Cloud Audit Logs で足りるか。プロンプト・応答自体の保全が必要なら、自前で BigQuery に保存する設計が要る |
| **コスト** | app のライセンス費用 vs. agent platform のトークン従量課金。想定リクエスト数での試算が必要 |
| **可用性・運用** | Cloud Run の最小インスタンス、タイムアウト、レート制限。Provisioned Throughput が必要な規模か |
| **既存 app 資産** | 現行 app のプロンプト・データソース設定をどこまで移すか。併存させるか |

---

## 参考リンク

- [Google AI から Gemini Enterprise agent platform への移行（比較表の出典）](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai?hl=ja)
- [Gemini Enterprise Agent Platform ドキュメント](https://docs.cloud.google.com/gemini-enterprise-agent-platform)
- [Google Gen AI SDK 概要](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/sdks/overview)
- 本リポジトリの実装例: [`agent/proposal-sample`](../agent/proposal-sample) — 静的 HTML + FastAPI + ADK を Cloud Run にデプロイする構成
