# HTML フロント構成で Gemini Enterprise agent platform は使えるか

> **この資料について**: 同じ論点を扱った資料が 2 つあります。
> - **本書（解説版）** — 「なぜそう言えるのか」を順に説明する形式。想定される反論への備えを含む。説明・説得の場で使う。
> - [`gemini-enterprise-agent-platform.md`](./gemini-enterprise-agent-platform.md)（**要点版**） — 事実と設定項目を簡潔にまとめた形式。手元の確認用。
>   モデル選定（2.5 Flash と 3.7 Flash の差分）は要点版の第 7 章にのみ記載しています。

**結論から言うと、使えます。** Gemini Enterprise app（プロンプトベースのノーコード app）を経由する必要はなく、
自前の HTML フロント + Python バックエンドから Gemini Enterprise agent platform（**旧 Vertex AI**）のモデル API を直接呼べます。
さらにその構成のほうが、**Google にデータを学習利用されない**状態を明示的に担保しやすくなります。

- 対象読者: 現在 Gemini Enterprise app を利用していて、自前 Web アプリ化を検討している関係者
- **名称について**: 「Gemini Enterprise agent platform」は **旧 Vertex AI** です。社内の既存資料やコード、`gcloud` のコマンド、
  SDK の引数（`vertexai=True`）、エンドポイント名（`aiplatform.googleapis.com`）には引き続き Vertex / aiplatform の名称が残っていますが、
  **同じものを指しています。**「Vertex AI を使う」と「agent platform を使う」は同じ意味です
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

この3者の違いは Google 自身が公式に区別しています
（[Google AI Studio、Gemini Enterprise Agent Platform、Gemini Enterprise app の比較](https://cloud.google.com/ai/gemini?hl=ja)）。
同ページの記述を引用すると:

> **Gemini Enterprise Agent Platform の Gemini API** … 「企業のお客様とデベロッパーは、Agent Platform の Gemini API を介して
> Google の最大かつ最も高性能な AI モデルを体験できます。」
>
> **Gemini Enterprise app** … 「直感的なチャット インターフェースを通じて Google の強力な AI モデルにアクセスしたり、（中略）
> 強力なノーコード ワークベンチを使用して、自身の専門知識を活かした自動化を構築し、会社全体で共有することもできます。」

つまり **app は「チャットUI + ノーコードのワークベンチ」という利用形態**であり、
**モデルを呼ぶ手段そのものは Agent Platform の Gemini API** です。
app は agent platform の上に乗っている利用形態のひとつであり、**app を通らないとモデルが使えないという依存関係はありません。**
自前アプリからは agent platform を直接呼びます。

### 2.2 コード例：Python から agent platform を呼ぶ

Google Gen AI SDK は、Google AI 側と agent platform 側の**両方に同じコードで繋がります**。差はクライアントの初期化だけです。

```python
# pip install google-genai
from google import genai

# ── agent platform（旧 Vertex AI）を使う。これが今回採用する経路 ────────────
client = genai.Client(
    vertexai=True,                       # ← ここが分岐点
    project="your-project-id",
    location="global",                   # 現状はグローバル エンドポイント（第5章）
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
GOOGLE_CLOUD_LOCATION=global
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

> **実装済みの参考例**: このリポジトリの [`agent/proposal-sample`](../README.md) が、まさにこの構成
> （静的 HTML + FastAPI + ADK、Cloud Run に `GOOGLE_GENAI_USE_VERTEXAI=TRUE` でデプロイ）で動いています。
> 「HTML フロントから agent platform が使えるか」の実証としてそのまま提示できます。

---

### 2.4 実行基盤の選択: Cloud Run と GKE

まず押さえておきたいのは、**この判断がアプリのコードに影響しない**ことです。`genai.Client()` は環境変数を読み、
ADC は Cloud Run のサービスアカウントでも GKE の Workload Identity でも同じように機能します。
本資料の結論（app 経由が不要・サービスアカウントで完結・データが学習に使われない）は**実行基盤に依存しません**。
つまり、後から入れ替えるコストは低く、ここで判断を止める必要はありません。

| 観点 | Cloud Run | GKE |
|---|---|---|
| 固定費 | `min-instances=0` なら未使用時はゼロ | クラスタが常時課金。**ただし既存クラスタに空き容量があれば追加費用はほぼゼロ** |
| サービスアカウントの割り当て | `--service-account` の 1 行 | Workload Identity の設定（KSA 作成 → GSA と紐付け → アノテーション） |
| デプロイ | `gcloud run deploy --source .` で完結 | Artifact Registry への push、マニフェスト、`kubectl` / CI |
| HTTPS・独自ドメイン | 自動 | ロードバランサと証明書の管理が必要 |
| アクセス制御 | IAM（`run.invoker`）や IAP をロードバランサなしで適用可 | Ingress + IAP。**既存の構成があるならそこに追加するだけ** |
| **VPC 境界（VPC-SC / 第5章）** | Direct VPC egress または Serverless VPC Access の構成が別途必要 | **Pod が VPC 内にあり、Private Google Access で素直に組める** |
| 隔離 | サービス単位で独立 | 同一クラスタの他ワークロードと影響し合う可能性（Namespace・リソース制限で緩和） |
| コールドスタート | あり（`min-instances=1` で回避、その分固定費が戻る） | なし（常駐） |
| 運用対象 | なし | クラスタのアップグレード、ノードプール、CVE パッチ |
| 監視・ログ・オンコール | 系統が 1 つ増える | 既存の運用にそのまま乗る |

#### 現状の方針: PoC は Cloud Run、本番は GKE

上の表は**定常運用**の比較です。既存の GKE クラスタを運用しているため、定常運用の段階では GKE に載せるのが妥当です。
Cloud Run の主な利点（固定費ゼロ、認証設定の簡便さ、運用対象なし）は、クラスタと運用体制が既にある時点でほぼ相殺されます。
「Cloud Run のほうが手軽」という一般論は、ゼロから作る場合の話です。加えて、第5章の VPC Service Controls を導入する場合、
Pod が VPC 内にある GKE のほうが境界設計が素直です。

**ただし PoC の段階は Cloud Run を使います。** ここは定常運用とは判断材料が異なります。

| PoC 固有の論点 | Cloud Run が有利な理由 |
|---|---|
| **同居ワークロードへの影響** | PoC のコード品質は読めません。Gemini の呼び出しは thinking と SSE で 1 リクエストが数十秒プロセスを占有するため、ノードリソースや HPA の挙動への影響が読みにくい。**別基盤に置けば、この影響が構造的にゼロになります** |
| **既存のセキュリティ設計への変更** | Cloud Run は PoC 用の GSA を紐付けるだけ。クラスタの Workload Identity 設定・RBAC・Ingress を一切変更しません。**審査に出す変更が小さいのは実務上大きい** |
| **撤退コスト** | 中止する場合はサービスを削除するだけ。Namespace、RBAC、Ingress ルール、監視設定の後始末が発生しません |
| **費用の可視性** | PoC 単独の費用が分離して見えます。GKE のノード費用に混ざると、費用対効果の判断ができません |
| **反復速度** | クラスタ変更に承認プロセスがある場合、`gcloud run deploy --source .` の数分との差が効いてきます |

**移行時に変わるのは 3 点だけです**: 認証の紐付け方（`--service-account` → Workload Identity）、マニフェスト、CI のデプロイ先。
**コンテナイメージとアプリケーションコードは同一**なので、後戻りのコストは低いままです。

> **判断が必要な点**: VPC Service Controls（第5章）の検証を PoC のスコープに含めるかどうかです。
> 含める場合、Cloud Run 側で Direct VPC egress の構成が必要になり、上記の「手軽さ」の利点が一部削れます。
> 境界の検証を本番設計フェーズに回すのであれば、PoC は Cloud Run で問題ありません。

**どちらを選んでも必要になること**: `proposal_app/store.py` のインメモリ状態は、GKE でレプリカを複数にした場合も保持されません
（Cloud Run と同様、むしろセッションアフィニティの分だけ厄介になります）。
BigQuery / GCS / Firestore への永続化は、実行基盤の選択とは独立に必要です。

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

### 3.2 コマンド例：Cloud Run にサービスアカウントを割り当ててデプロイ（Cloud Run の場合）

```bash
gcloud run deploy proposal-app \
  --source . \
  --project="$PROJECT" \
  --region=asia-northeast1 \
  --service-account="$SA_EMAIL" \
  --set-env-vars=GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=global,GEMINI_MODEL=gemini-2.5-flash
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

### 3.3 GKE の場合（Workload Identity）

既存の GKE クラスタに載せる場合は、Kubernetes サービスアカウント（KSA）を Google サービスアカウント（GSA）に紐付けます。
これで Pod 内のコードから ADC が機能します。**アプリのコードは一切変えません。**

```bash
PROJECT=your-project-id
GSA=app-runner@$PROJECT.iam.gserviceaccount.com
NS=default          # Pod を置く Namespace
KSA=app-runner      # Kubernetes サービスアカウント名

# 1) クラスタで Workload Identity を有効化（未設定の場合のみ）
gcloud container clusters update <cluster> \
  --project="$PROJECT" --location=<location> \
  --workload-pool="${PROJECT}.svc.id.goog"

# 2) Kubernetes 側のサービスアカウントを作る
kubectl create serviceaccount "$KSA" --namespace "$NS"

# 3) KSA が GSA を借用できるようにする
gcloud iam service-accounts add-iam-policy-binding "$GSA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT}.svc.id.goog[${NS}/${KSA}]"

# 4) KSA に GSA を紐付ける
kubectl annotate serviceaccount "$KSA" --namespace "$NS" \
  iam.gke.io/gcp-service-account="$GSA"
```

Deployment 側では `serviceAccountName` に KSA を指定し、環境変数を渡します。

```yaml
spec:
  template:
    spec:
      serviceAccountName: app-runner        # 上で作った KSA
      containers:
        - name: app
          image: <region>-docker.pkg.dev/<project>/<repo>/proposal-app:<tag>
          env:
            - name: GOOGLE_GENAI_USE_VERTEXAI
              value: "TRUE"
            - name: GOOGLE_CLOUD_PROJECT
              value: your-project-id
            - name: GOOGLE_CLOUD_LOCATION
              value: global
            - name: GEMINI_MODEL
              value: gemini-2.5-flash
```

IAM ロール（`roles/aiplatform.user` / `roles/bigquery.jobUser` / `roles/bigquery.dataViewer`）は **GSA 側に付与します**。KSA には付けません。
Cloud Run の場合と同じく、**サービスアカウントキー（JSON）は作成しません。**

### 3.4 ローカル開発時

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

| 項目 | Gemini API（AI Studio） | Gemini Enterprise Agent Platform |
|---|---|---|
| エンドポイント名 | `generativelanguage.googleapis.com` | `aiplatform.googleapis.com` |
| 認証 | API キー または OAuth | **Google Cloud サービスアカウント** |
| **Google モデルの改善** | 無料枠: プロンプトとレスポンスは Google サービスの改善に使用されることがある<br>有料枠: 使用されない | **プロンプト、レスポンス、データは Google サービスの改善に使用されない** |
| コンプライアンスとガバナンス | コンプライアンス認証（HIPAA、SOC2 等）なし。規制対象の顧客は Agent Platform を使用すること | HIPAA や SOC2 等の認証への準拠をサポート。データ所在地、顧客管理の暗号鍵、アクセスの透明性を提供 |
| セキュリティ | API キー認証 | IAM（サービスアカウント、OAuth）による認証。VPC によるセキュリティ強化 |
| インフラストラクチャ | グローバルエンドポイント | グローバルエンドポイントとリージョンエンドポイント |
| 取引条件 | 標準利用規約 | データ処理・セキュリティ・プライバシーに関するエンタープライズ対応の規約 |
| エンタープライズサポートと SLA | なし | 24 時間 365 日のサポートと SLA |

この表で押さえるべきは、**Agent Platform 側は「無料枠／有料枠」の区別なく一律で「Google サービスの改善に使用されない」と明記されている**点です。
Gemini API（AI Studio）側は無料枠が対象になります。

> **注記**: 契約条件・データ処理条項の正確な文言は、上記 URL および Google Cloud のデータ処理規約
> （Cloud Data Processing Addendum）の原文で最終確認してください。条件は改定されることがあります。
>
> **「無料だから」という理由で AI Studio 側の API キー経路を選ぶと、無料枠のデータ利用条件を踏みます。**
> 費用と引き換えにデータ利用条件を落とすことになるため、今回の要件では選択肢になりません。

### この表の読み方（説明の要点）

説明の場では、次の一文に集約できます。

> **API キーで叩く Google AI 側ではなく、サービスアカウントで叩く agent platform 側を使う。
> それだけで、入力したデータが Google のモデル学習に使われる経路から外れる。**

そして第3章のとおり、自前 Web アプリ構成では **そもそも API キーを使う理由がない**（サービスアカウントのほうが楽）ので、
「安全な側を選ぶために何かを我慢する」という話にはなりません。

**補足（想定される突っ込み）**: 「agent platform でも API キーが使えるのでは？」というのは事実です。
ただし決め手は**資格情報の種類ではなく、どちらのプラットフォーム（エンドポイント）を叩いているか**です。
agent platform 側で発行する Google Cloud API キーは Cloud の契約条件の下にあり、Google AI 側の API キーとは別物です。
とはいえ本番では **ADC（サービスアカウント）が推奨**であり、鍵の管理コストもなくなるので、
今回の構成では ADC 一択で問題ありません。

---

## 5. 「学習に使われない」と「痕跡が残らない」は別物

ここは説明の場で最も突っ込まれやすい箇所なので、先回りして整理します。
第4章で担保されるのは **「モデルの学習・製品改善に使われない」** ことであって、
**「データが一切どこにも記録されない」** ことではありません。両者は別の話です。

| 主張 | 何で担保されるか | 追加でやること |
|---|---|---|
| **モデルの学習に使われない** | agent platform を使うこと（Cloud のデータ処理条項） | なし（経路を選ぶだけ） |
| **データが国外に出ない** | `location` にリージョンを明示（例: `asia-northeast1`） | **現状は `global` を選択しているため、これは担保していない**（下記参照） |
| **プロジェクト外に持ち出せない** | VPC Service Controls でサービス境界を設定 | 境界設定と、境界越えが必要な連携の洗い出し |
| **不正利用検知のためのログ保持** | — | **要確認事項。** 濫用検知目的の一時的なログ保持が別途規定されている場合があるため、ゼロデータ保持や検知除外の適用可否を Google 側に確認する |
| **保管データの暗号鍵を自社管理** | CMEK | 鍵の運用体制 |
| **外部検索にクエリが出ない** | **グラウンディング機能の設定** | 下記参照 |

### リージョンについて（現状は `global`）

現状は `location="global"`（グローバル エンドポイント）を使っています。ここは誤解されやすいので、はっきり分けて書きます。

- **「Google のサービス改善に使われない」は global でも変わりません。** 第4章の保証はエンドポイントの選択に依存しないためです。
  今回の説明の主眼はここなので、**global であることは主張を弱めません。**
- **変わるのは「どのリージョンで処理されるか」だけ**です。global は空きのあるリージョンで処理されるため、処理場所が固定されません。
  可用性が高く（容量不足による 429 が出にくい）、Gemini 3 系では料金も安いという利点があります。
- **データを国内に留めるという明示的な要件がある場合のみ**、`asia-northeast1` 等への固定を検討します。
  その場合、Gemini 3 系以降では料金が約 10% 増になります（2026年7月1日以降、一般提供版の Gemini 3 以降のモデルに適用）。

なお、**Cloud Run のデプロイ先リージョンと Gemini の `location` は別物**です。Cloud Run を `asia-northeast1` に置いていても、
`location="global"` であれば推論の処理リージョンは固定されません。第3章のデプロイ例で `--region=asia-northeast1` としているのは
Cloud Run 側の話であり、Gemini の処理リージョンとは無関係です。

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
| **データ所在地の要件** | 現状は `global` で処理リージョンを固定していない。国内に留める要件があるかを確認し、ある場合はリージョン固定への切り替えと約 10% の料金増を織り込む |
| **使用モデル** | 現時点は 2.5 Flash ベース。3.7 Flash（2026年8月に GA）への更新を検討する場合の差分は[要点版の第7章](./gemini-enterprise-agent-platform.md)を参照 |
| **実行基盤** | PoC は Cloud Run、本番は GKE の方針（第2.4章）。GKE 移行時に、Namespace とリソース制限による隔離、レプリカ数、`store.py` の永続化方針を決める。VPC-SC の検証を PoC に含めるかは要判断 |
| **ログ保持・濫用検知の除外** | 第5章のとおり、要件が厳しい場合は Google 側への確認が必要 |
| **監査要件** | Cloud Audit Logs で足りるか。プロンプト・応答自体の保全が必要なら、自前で BigQuery に保存する設計が要る |
| **コスト** | app のライセンス費用 vs. agent platform のトークン従量課金。想定リクエスト数での試算が必要 |
| **可用性・運用** | レプリカ数とタイムアウト、レート制限。Provisioned Throughput が必要な規模か（Cloud Run の場合は最小インスタンス数も） |
| **既存 app 資産** | 現行 app のプロンプト・データソース設定をどこまで移すか。併存させるか |

---

## 参考リンク

- [Google AI から Gemini Enterprise agent platform への移行（比較表の出典）](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai?hl=ja)
- [Google AI Studio、Gemini Enterprise Agent Platform、Gemini Enterprise app の比較（3者の公式な位置づけ）](https://cloud.google.com/ai/gemini?hl=ja)
- [Gemini Enterprise Agent Platform ドキュメント](https://docs.cloud.google.com/gemini-enterprise-agent-platform)
- [Google Gen AI SDK 概要](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/sdks/overview)
- 本リポジトリの実装例: [`agent/proposal-sample`](../README.md) — 静的 HTML + FastAPI + ADK を Cloud Run にデプロイする構成
