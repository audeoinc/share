# HTML ベースの自社 Web アプリから Gemini を利用する構成について

## この資料の目的

> **関連資料**: 同じ論点を、想定される反論への備えを含めて順に説明した**解説版**が
> [`gemini-agent-platform-explainer.md`](./gemini-agent-platform-explainer.md) にあります。
> 説明・説得の場ではそちらを、事実と設定項目の確認には本書を使ってください。

「Gemini を業務で使うには Gemini Enterprise app（プロンプト入力型の Web アプリ）を経由しなければならないのか」という論点に対して、以下を整理する。

> **名称について**: 本書で「Gemini Enterprise Agent Platform」と呼んでいるものは、**旧 Vertex AI** である。
> 社内の既存資料やコード、`gcloud` のコマンド、SDK の引数（`vertexai=True`）、エンドポイント名（`aiplatform.googleapis.com`）には
> 引き続き Vertex / aiplatform の名称が残っているが、**同じものを指している。**

- 自社で作る HTML + Python の Web アプリからも Gemini は問題なく利用できる
- その構成でも、プロンプトやデータが Google のサービス改善に使われない状態を確保できる

---

## 結論

1. **Gemini Enterprise app の利用は、Gemini に推論させるための必須条件ではない。**
2. **Web サーバー内の Python から Gemini Enterprise Agent Platform（旧 Vertex AI）の API を直接呼び出せる。**
3. **GCP 内のコンポーネント同士であれば、サービスアカウントによる認証で Gemini 呼び出しと BigQuery アクセスの両方が完結する。認証キーの配布は不要。**
4. **この構成（Agent Platform 経由）であれば、プロンプト・レスポンス・データが Google サービスの改善に使用されることはない。**

---

## 1. Gemini Enterprise app と Agent Platform は別のもの

名称が似ているため混同されやすいが、レイヤーが異なる。

| 名称 | 位置づけ | 利用者 |
|---|---|---|
| Gemini Enterprise app | 社員が使う Web アプリ（検索・チャット・エージェント実行の入口） | エンドユーザー |
| Gemini Enterprise Agent Platform | 開発者が API / SDK で呼び出すモデル基盤（旧 Vertex AI） | 開発者・アプリケーション |

今回作ろうとしている業務アプリが必要とするのは **後者だけ**。Gemini Enterprise app のライセンスや画面を経由する必要はない。

この区別は Google 自身が公式に書き分けている（[Google AI Studio、Gemini Enterprise Agent Platform、Gemini Enterprise app の比較](https://cloud.google.com/ai/gemini?hl=ja)）。同ページの記述:

> **Gemini Enterprise Agent Platform の Gemini API** — 「企業のお客様とデベロッパーは、Agent Platform の Gemini API を介して Google の最大かつ最も高性能な AI モデルを体験できます。」
>
> **Gemini Enterprise app** — 「直感的なチャット インターフェースを通じて Google の強力な AI モデルにアクセスしたり、（中略）強力なノーコード ワークベンチを使用して、自身の専門知識を活かした自動化を構築し、会社全体で共有することもできます。」

つまり app は「チャット UI + ノーコードのワークベンチ」という**利用形態**であり、モデルを呼ぶ手段そのものは Agent Platform の Gemini API である。

なお Gemini Enterprise app 側は UI が固定されており、HTML で自作・差し替えすることはできない。BigQuery の集計をグラフで見せる、条件入力フォームから処理を起動する、といった業務アプリ的な画面を作る場合は、自社で Web アプリを構築する必要がある。

---

## 2. 想定構成

```
ブラウザ（HTML + JavaScript）
        │  HTTPS（同一オリジンの /api/... を呼ぶだけ）
        ▼
Cloud Run（Python / FastAPI）      ← アプリケーションのコードはここ
        ├──────────────► BigQuery（業務データ）
        └──────────────► Gemini Enterprise Agent Platform（推論）
```

処理の流れ:

1. ブラウザの JavaScript が Cloud Run 上の API を呼ぶ
2. Python が BigQuery からデータを取得する
3. 取得したデータをもとに Gemini に推論させる
4. 結果を JSON で返し、ブラウザ側で表示する

推論結果を次の処理工程の入力として使うことも可能。`response_schema` による構造化出力を使えば、モデルの出力を型付きの JSON として受け取れるため、後続処理に安全に渡せる。

**重要な前提: ブラウザから Gemini を直接呼ばない。** 直接呼ぶ設計にすると資格情報をクライアントに置くことになり、漏洩・課金事故・データ経路の説明不能という問題が同時に発生する。呼び出しは必ずサーバー側（Python）に閉じる。静的ファイルと API を同一オリジンで配信すれば CORS も不要になる。

### 実装イメージ（サーバー側）

```python
from google.cloud import bigquery
from google import genai

bq = bigquery.Client()
ai = genai.Client(
    vertexai=True,                  # Agent Platform を利用
    project=PROJECT_ID,
    location="global",              # 現状はグローバル エンドポイント（第 5.1 章）
)

@app.post("/ask")
def ask(q: Query):
    rows = list(bq.query(SQL, job_config=...).result())
    r = ai.models.generate_content(
        model="gemini-2.5-flash",
        contents=f"データ:\n{rows}\n\n質問:{q.text}",
    )
    return {"answer": r.text}
```

`vertexai=True` の指定が、Agent Platform のエンドポイント（`aiplatform.googleapis.com`）を使うことを意味する。
コードに書かず、環境変数（`GOOGLE_GENAI_USE_VERTEXAI=TRUE` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`）で指定することもできる。Cloud Run ではそちらのほうが扱いやすい。

### 実装イメージ（ブラウザ側）

```javascript
// 鍵もプロジェクト ID もクライアントには一切出てこない
const res  = await fetch("/ask", {
  method:  "POST",
  headers: { "Content-Type": "application/json" },
  body:    JSON.stringify({ text: "この顧客への提案を作成して" }),
});
const data = await res.json();
document.querySelector("#out").textContent = data.answer;
```

> **社内に実装済みの参考例**: 本リポジトリの [`agent/proposal-sample`](../README.md) が、まさにこの構成
> （静的 HTML + FastAPI + ADK、Cloud Run に `GOOGLE_GENAI_USE_VERTEXAI=TRUE` でデプロイ）で動作している。
> 「HTML フロントから Agent Platform が使えるのか」という問いに対しては、動いている実物を示すのが最も早い。

---

## 3. 認証はサービスアカウントで完結する

### 仕組み

Cloud Run にサービスアカウントを割り当てると、ADC（Application Default Credentials）が自動的にその権限を使用する。**コード内に API キーや認証情報を書く必要がない。**

ADC は以下の順に認証情報を探索する。

1. 環境変数 `GOOGLE_APPLICATION_CREDENTIALS` が指すファイル
2. ローカル開発時の `gcloud auth application-default login` の認証情報
3. 実行環境のメタデータサーバー（Cloud Run / GKE / GCE）

Cloud Run 上では 3 が使われるため、同じコードがローカルでも本番でも動作する。

### 必要な IAM ロール

| ロール | 用途 |
|---|---|
| `roles/aiplatform.user` | Gemini の呼び出し |
| `roles/bigquery.jobUser` | クエリの実行 |
| `roles/bigquery.dataViewer` | データの参照 |

### 設定例

```bash
gcloud iam service-accounts create app-runner

for R in roles/aiplatform.user roles/bigquery.jobUser roles/bigquery.dataViewer; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:app-runner@$PROJECT.iam.gserviceaccount.com" \
    --role="$R"
done

gcloud run deploy my-api \
  --service-account=app-runner@$PROJECT.iam.gserviceaccount.com
```

### 注意点

- `--service-account` を指定しないと Compute Engine のデフォルトサービスアカウント（過大な権限を持つことが多い）が使われる。専用のサービスアカウントを必ず作成する。
- **サービスアカウントキー（JSON ファイル）は作成しない。** ADC が機能する環境では不要であり、鍵ファイルは漏洩・ローテーション・保管のリスクを生む。組織のポリシーで `iam.disableServiceAccountKeyCreation` を有効にしておくとよい。
- GCP 外（AWS・オンプレ等）にアプリを置く場合は、鍵ファイルではなく Workload Identity 連携を使う。
- `roles/bigquery.dataViewer` はプロジェクト全体ではなく、データセット単位で付与するほうが望ましい（`bq add-iam-policy-binding`）。

---

## 4. データが Google に利用されない根拠

公式ドキュメントの比較表が根拠となる。

**参照: [Google AI Studio から Gemini Enterprise Agent Platform に移行する](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai?authuser=1&hl=ja)**

同ページの「Google モデルの改善」の項目に、以下の通り記載されている。

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

要点は 2 つ。

- Agent Platform 経由であれば、**枠の区別なく一律で「Google サービスの改善に使用されない」** と明記されている。
- 認証がサービスアカウントであること自体が、Agent Platform を使っていることの証左になる（API キー認証は Gemini API 側の方式）。

したがって、今回の構成（Cloud Run + サービスアカウント + `vertexai=True`）は、この要件を満たす。

### 想定される突っ込みへの備え

- **「Agent Platform でも API キーが使えるのでは？」** — テスト用途に限り Google Cloud API キーを使う方法は存在する。ただしそれは Cloud 側で発行される別物であり、AI Studio 側の API キーとは異なる。データ利用条件を決めるのは**資格情報の種類ではなく、どちらのエンドポイントを叩いているか**（`aiplatform.googleapis.com` か `generativelanguage.googleapis.com` か）である。本番では公式にもサービスアカウント（ADC）が前提とされているため、今回の構成では ADC 一択でよい。
- **「無料枠なら安く済むのでは？」** — 無料枠はまさに「プロンプトとレスポンスが Google サービスの改善に使用されることがある」対象であり、費用と引き換えにデータ利用条件を落とすことになる。今回の要件では選択肢にならない。

---

## 5. あわせて設定すべき項目

「学習に使われない」ことと「痕跡が一切残らない」ことは別の話であるため、本番運用では以下も併せて設定する。

### 5.1 リージョンの選択（現状: global エンドポイント）

現状は `location="global"`（グローバル エンドポイント）を使用している。この選択で変わること・変わらないことを整理する。

| | global エンドポイント（現状） | リージョン指定（例: `asia-northeast1`） |
|---|---|---|
| **プロンプト・レスポンスの学習利用** | **されない** | されない |
| 処理されるリージョン | **固定されない**（空きのあるリージョンで処理される） | 指定したリージョンに固定される |
| 可用性・キャパシティ | 高い（容量不足による 429 が出にくい） | そのリージョンの容量に依存 |
| Gemini 3 系以降の料金 | 標準 | **約 10% 増**（第 7.3 章） |

**今回の主眼である「Google のサービス改善に使用されない」は、エンドポイントの選択に依存しない。** global でも第 4 章の保証はそのまま適用される。
global で変わるのは**データの所在地**（どのリージョンで処理されるか）である。

したがって、**データを国内に留めるという明示的な要件がない限り、global のままでよい。** 要件が生じた場合に `asia-northeast1` 等への固定を検討する。
その場合は、使用したいモデルが該当リージョンで提供されているかの事前確認（モデルによって提供リージョンが異なる）と、上記の料金差の試算が必要になる。

なお、**Cloud Run のデプロイ先リージョンと Gemini の `location` は別物**である。Cloud Run を `asia-northeast1` に置いていても、
`location="global"` であれば推論の処理リージョンは固定されない。

> **要確認**: VPC Service Controls（第 5.2 章）とグローバル エンドポイントの組み合わせについては、境界の適用範囲を設計時に確認すること。

### 5.2 VPC Service Controls

セキュリティ境界を設定し、`aiplatform.googleapis.com` と `bigquery.googleapis.com` を保護対象に含めることで、境界外へのデータ持ち出しを防ぐ。追加費用はかからないため、後付けではなく設計初期から導入するほうが工数が少ない。

### 5.3 グラウンディング機能の扱い

Google 検索によるグラウンディングを有効にすると、プロンプト由来のクエリが検索側に送信される。機密データを扱う経路では明示的にオフにしておく。

社内データを参照させたい場合は、Google 検索ではなく BigQuery からアプリ側で取得してプロンプトに含める（第2章の構成）か、社内データを対象としたグラウンディングを使う。現行の Gemini Enterprise app ではデータソース設定が管理画面側にあるため見えにくいが、自社アプリではコード上で「何を参照しているか」が明示的になる。この点はむしろ説明しやすくなる。

### 5.4 不正使用モニタリングのログ保持

学習には使用されないが、不正利用検知のために入出力が一定期間保持される仕組みがある。保持自体が許容できない要件がある場合は、無効化（ゼロデータ保持）の可否を Google Cloud の営業担当に確認する。これは契約上の対応であり、実装では変更できない。

### 5.5 自社アプリ側のログ

Google 側の話とは別に、**自分たちのアプリがプロンプト本文を Cloud Logging に書き出していないか**を確認する。デバッグ目的の `print()` がそのまま残っていると、機微データがログに蓄積される。ログには ID や件数のみを出し、本文は出さない方針とする。

---

## 6. Gemini Enterprise app との棲み分け

両者は排他ではないが、目的が異なる。

| | Gemini Enterprise app | 自社 Web アプリ + Agent Platform |
|---|---|---|
| 画面 | Google が提供（固定） | 自由に設計可能 |
| 向く用途 | 社内ドキュメントの横断検索、汎用的な質問応答 | 業務プロセスへの組み込み、データ可視化、定型処理 |
| 認証 | 社員の ID（IdP 連携） | サービスアカウント（+ フロントは IAP / Firebase Auth） |
| アクセス制御 | ユーザーごとの権限を反映 | アプリ側で設計する必要あり |
| プロンプト管理 | 管理画面 | コード・設定ファイル（Git で版管理・レビュー可能） |

現在 Gemini Enterprise app を利用していることは、自社 Web アプリを構築する妨げにはならない。同じ Google Cloud プロジェクト内で、別の使い方として並存できる。

---

## 7. モデル: 2.5 Flash と 3.7 Flash の差分

**現時点の方針は Gemini 2.5 Flash ベース**とする。今後 3.7 Flash（2026年8月リリース）への移行を検討するため、
本章に差分を整理しておく。第2章の実装イメージのモデル ID は 2.5 Flash のままで問題ない。

### 7.1 API の差分（コード変更が必要）

Gemini 3 系（3.7 Flash を含む）は、生成パラメータの扱いが 2.5 系と異なる。**モデル ID を差し替えるだけでは動かない。**

| 項目 | 2.5 Flash | 3.7 Flash | 必要な対応 |
|---|---|---|---|
| 推論量の制御 | `thinking_budget`（トークン数で指定） | **`thinking_level`（`LOW` / `MEDIUM`（既定） / `HIGH`）** | 置き換える。両方を同一リクエストに入れると **400 エラー** |
| `temperature` / `top_p` / `top_k` | 調整して使う | 生成設定から外すことが推奨 | 既存の生成設定を見直す |
| `candidate_count` | 利用可 | 非対応 | 削除する |
| マルチターンのツール利用 | — | **thought signature を含む会話履歴を、加工せずそのまま渡す必要がある** | 履歴を要約・切り詰めしている実装は要修正 |

> 本リポジトリの [`agent/proposal-sample`](../README.md) は既に `thinking_level` を使用しているため、この点では 3 系にそのまま乗る。

### 7.2 能力面の差分

- **コンテキスト**: 入力 1,048,576 トークン / 出力 65,536 トークン。2.5 Flash と同等の枠であり、ここは移行の動機にならない。
- **入力モダリティ**: テキスト・画像・音声・動画。**2.5 Flash は音声入力のみ別料金**（後述）だが、3.7 Flash は音声を含めて単一の入力料金になる。
- **伸びている領域**: コーディングとエージェント動作（ツールを連続で使う、複雑なタスクを最後までやり切る）。
  逆に言えば、**単発の要約・分類・定型文生成が主用途なら、移行の効果は小さい。**
  今回の業務アプリが「BigQuery から取得したデータを要約して提案文を作る」程度であれば、2.5 Flash で十分に成立する。

### 7.3 コストとリージョンの差分（最も影響が大きい）

100 万トークンあたりの料金（[Gemini Enterprise Agent Platform の料金](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing?hl=ja) より）。

| モデル | 入力 | 音声入力 | 出力（回答＋推論） |
|---|---|---|---|
| Gemini 2.5 Flash | $0.30 | $1.00 | $2.50 |
| Gemini 3.7 Flash（〜2026/12/31・グローバル） | $0.75 | 入力に含む | $3.75 |
| Gemini 3.7 Flash（〜2026/12/31・**非グローバル**） | $0.825 | 入力に含む | $4.125 |
| Gemini 3.7 Flash（2027/1/1〜・グローバル） | $1.50 | 入力に含む | $7.50 |
| Gemini 3.7 Flash（2027/1/1〜・**非グローバル**） | $1.65 | 入力に含む | $8.25 |

押さえるべき点が 3 つある。

1. **「グローバル」と「非グローバル」で価格が違う（約 10% 増）。**
   **現状は `location="global"` を使用しているため、適用されるのはグローバル料金**（導入価格で入力 $0.75 / 出力 $3.75）。
   非グローバルの行は、将来データ所在地の要件が生じてリージョンを固定する場合の参考値である。
   2.5 Flash にはこの区別がないため、**モデルを上げたうえでリージョンを固定すると、そこで初めて約 10% の割増が乗る**。
   なお、この非グローバル料金は 2026 年 7 月 1 日から一般提供版の Gemini 3 以降のモデル ファミリーに適用されている
   （それ以前は非グローバル エンドポイントにもグローバル料金が適用されていた）。
2. **2026年12月31日までは導入価格であり、2027年1月1日から約2倍になる。**
   試算は導入価格ではなく、**2027年以降の価格**で行う。
3. **2.5 Flash からの単純な値上がり幅は大きい。**
   入力で 2.5〜5.5 倍、出力で 1.5〜3.3 倍。推論（thinking）のトークンも出力側に課金されるため、
   `thinking_level` を既定の `MEDIUM` のまま使うと、想定より出力トークンが増えやすい。

### 7.4 移行時に確認すること

- **リリース段階**: 3.7 Flash は 2026 年 8 月 13 日に**一般提供（GA）**として提供が開始されている。
  料金ページ上でも、他モデルに付いている「プレビュー版」の表記（例: `Gemini 3.1 Pro プレビュー版`、`Gemini 3 Flash プレビュー`）は
  3.7 Flash には付いていない。ただしリリース直後のモデルであるため、**採用を決める前にリリースノートで段階を再確認すること。**
- **提供リージョン**: 現状は `location="global"` のため、特定リージョンでの提供有無を気にする必要はない（第 5.1 章）。
  データ所在地の要件が生じてリージョンを固定する場合にのみ、該当リージョンでの提供有無の確認が必要になる。
- **Provisioned Throughput の対応状況**。料金ページの Provisioned Throughput 一覧には 3.6 / 3.5 / 3 Flash と 2.5 Flash の記載はあるが、
  **3.7 Flash の記載がない**（2026年8月時点）。定常的なスループット確保が必要な場合は、対応状況を確認する。
- **グラウンディングの無料枠**。2.5 Flash には 1 日 1,500 件のグラウンディング プロンプトが無償で含まれるが、3.7 Flash には同様の記載がない。
  ただし第 5.3 章のとおり、今回は Google 検索によるグラウンディングを使わない前提なので、実質的な影響はない。
- **既存プロンプトの再評価**。`thinking_level` の既定が `MEDIUM` であること、生成パラメータを外すことから、出力の傾向が変わる。
  モデルを上げた直後に品質評価をやり直す前提で計画する。
- **構造化出力の互換性**。`response_schema` を使っている箇所が同じスキーマで通るかを確認する。

> **注記**: 本章の API 差分とベンチマークの傾向は、公式ドキュメントおよび公開情報をもとに整理したもの。
> 料金表は上記リンク（日本語版）から取得した実値だが、**移行を実際に決める段階では、
> 料金ページとモデルの提供リージョン一覧を最新の状態で再確認すること。**

---

## 8. 残論点

以下は今後決める必要がある。

- **フロントエンドの認証方式**: IAP（Google アカウントでの認証、ロードバランサ配下）か Firebase Auth か
- **アクセス制御の粒度**: 全ユーザーが同じデータを見てよいか。ユーザーごとに閲覧範囲を変える必要がある場合は、アプリ側でのフィルタリング実装、または Agent Runtime + Agent Identity（ユーザー権限の委任）の検討が必要。BigQuery 側の行レベルセキュリティ／承認済みビューで担保する案もある
- **推論の実行場所**: BigQuery の SQL 内（`AI.GENERATE` 等）で完結させるか、アプリケーション側から呼び出すか
- **データ所在地の要件の有無**: 現状は `location="global"` で、処理リージョンは固定していない（第 5.1 章）。国内に留める要件があるかを確認する。ある場合は、リージョン固定への切り替えと、Gemini 3 系での約 10% の料金増（第 7.3 章）を織り込む
- **監査要件**: Cloud Audit Logs で足りるか。プロンプトと応答自体の保全が必要な場合は、自社で BigQuery に保存する設計が必要
- **コスト**: Gemini Enterprise app のライセンス費用と、Agent Platform のトークン従量課金の比較。想定リクエスト数での試算
- **既存 app 資産の扱い**: 現行 app のプロンプト・データソース設定をどこまで自社アプリ側に移すか、並存させるか

---

## 参考リンク

- [Google AI Studio から Gemini Enterprise Agent Platform に移行する（第4章の比較表の出典）](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/migrate-google-ai?authuser=1&hl=ja)
- [Google AI Studio、Gemini Enterprise Agent Platform、Gemini Enterprise app の比較（3者の公式な位置づけ）](https://cloud.google.com/ai/gemini?hl=ja)
- [Gemini Enterprise Agent Platform の料金（第7章の料金表の出典）](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing?hl=ja)
- [Gemini Enterprise Agent Platform ドキュメント](https://docs.cloud.google.com/gemini-enterprise-agent-platform)
- 社内の実装例: [`agent/proposal-sample`](../README.md)
