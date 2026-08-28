# Gen AI SDK と ADK の使い分け

## この資料の目的

Gemini を使うとき、**`google-genai`（Gen AI SDK）だけで書くか、ADK（Agent Development Kit）を使うか**の判断基準を整理する。

簡単な用途は SDK だけで完結する。それは正しく、無理に ADK を使う理由はない。
問題は「**どこから先が SDK では割に合わなくなるのか**」で、本書はその境界線を具体的に示す。

- 関連資料: [`gemini-enterprise-agent-platform.md`](./gemini-enterprise-agent-platform.md)（実行基盤・認証・データ利用）

---

## 結論

**判断の一行基準はこれで足りる。**

> **制御フローを自分のコードで書き切れるなら SDK。
> 「次に何をするか」をモデル自身に決めさせるなら ADK。**

言い換えると、

| こう書けるなら | 使うもの |
|---|---|
| `if` と `for` で処理順を固定できる。呼び出しは 1 回、または自分で決めた順に数回 | **SDK** |
| 「どのツールを何回呼ぶか」が入力によって変わる。モデルに判断させたい | **ADK** |

そして重要な点として、**この判断は後から変えられる。** ADK は SDK の置き換えではなく上に乗るレイヤーなので、
SDK で書いたプロンプトとツール関数は、ADK に移るときそのまま流用できる（第 6 章）。
**今 SDK で始めることは、将来 ADK に移る妨げにならない。**

---

## 1. 両者は競合ではなく、レイヤーが違う

最初に押さえるべきは、**ADK は SDK を置き換えるものではない**ということ。ADK は内部で Gen AI SDK を使っている。

```
  あなたのアプリケーション（FastAPI など）
        │
        ├─── ADK を使う場合 ────────────┐
        │     エージェント定義            │  ← 「何をするか」を宣言的に書く
        │     ツールの実行ループ          │  ← ADK が回す
        │     セッション / 状態管理       │
        │     コールバック / 評価         │
        │                                 │
        ▼                                 ▼
  google-genai（Gen AI SDK）  ←───────────┘   ← 生成 API の薄いクライアント
        │
        ▼
  Gemini Enterprise Agent Platform（旧 Vertex AI）
```

| | Gen AI SDK（`google-genai`） | ADK（`google-adk`） |
|---|---|---|
| 役割 | 生成 API を呼ぶためのクライアント | エージェントを組み立てる**フレームワーク** |
| 抽象度 | 低い（HTTP の薄いラッパー） | 高い（エージェント、ツール、セッション、状態） |
| 制御フロー | **自分で書く** | ADK が回す（モデルの判断に従う） |
| 依存 | 単体で完結 | 内部で Gen AI SDK を使う |
| 認証 | ADC / API キー | **同じ**（ADC がそのまま効く） |

**認証・リージョン・データ利用条件は両者で同一**である。ADK を使っても第4章（データが学習に使われない）の前提は変わらない。
`GOOGLE_GENAI_USE_VERTEXAI=TRUE` などの環境変数も共通である。

---

## 2. 同じ処理を両方で書くと

### 2.1 1 回の呼び出しで終わる場合 — SDK で十分

```python
from google import genai

client = genai.Client()          # 環境変数から Agent Platform に接続

resp = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=f"次の顧客データを踏まえて提案文を作成:\n{rows}",
)
print(resp.text)
```

構造化出力もこの範囲。**ここで ADK を持ち出す理由はない。**

```python
from pydantic import BaseModel

class ProposalOut(BaseModel):
    title: str
    body: str
    recommended_product_ids: list[str]

resp = client.models.generate_content(
    model="gemini-2.5-flash",
    contents=prompt,
    config={"response_mime_type": "application/json",
            "response_schema": ProposalOut},
)
proposal = ProposalOut.model_validate_json(resp.text)
```

### 2.2 ツールを使う場合 — ここが分岐点

モデルにツール（関数）を使わせたい場合、SDK では**呼び出しループを自分で書く**ことになる。

```python
# SDK だけでツールを使う（概念コード）
contents = [user_message]

while True:
    resp = client.models.generate_content(
        model=MODEL, contents=contents,
        config={"tools": [list_customers, get_purchase_history]},
    )

    calls = resp.function_calls
    if not calls:
        break                                   # ツール呼び出しがなければ完了

    contents.append(resp.candidates[0].content) # ← モデルの応答を履歴に積む
    for call in calls:                          # ← 複数を並列で返してくることがある
        result = dispatch(call.name, call.args) # ← 自分でディスパッチ
        contents.append(to_function_response(call, result))
    # 例外、リトライ、無限ループの打ち切り、トークン上限、履歴の切り詰め … すべて自前
```

**1〜2 往復なら、これで問題ない。** 実際、多くのケースはここで足りる。

割に合わなくなるのは、次が積み上がったときである。

- 並列で返ってくる複数のツール呼び出しの扱い
- ツールが例外を投げたときにモデルへ返す形式
- 往復回数の上限と打ち切り
- 会話履歴の管理（**Gemini 3 系では thought signature を含む履歴を加工せずに渡す必要がある**。要約や切り詰めを自作すると壊れやすい）
- どのツールをどの順で呼んだかのログ

**これらは「エージェントを書くと必ず出てくる定型処理」であり、ADK が提供しているのはまさにここである。**

### 2.3 ADK で書く

```python
from google.adk.agents import LlmAgent

agent = LlmAgent(
    name="analyst",
    model=MODEL,
    instruction="顧客IDを受け取り、属性と購買履歴から現状とリスクを要約する。",
    tools=[get_customer_detail, get_purchase_history, list_products],
    output_key="analysis",       # 結果を state["analysis"] に格納
)
```

ループ、ディスパッチ、履歴管理、エラー処理は ADK 側にある。
**ツール関数は通常の Python 関数のまま**で、型ヒントと docstring からスキーマが生成される（本リポジトリの `proposal_app/tools.py` がその形）。

---

## 3. 機能の対応表

| やりたいこと | SDK 単体 | ADK |
|---|---|---|
| 1 回の生成、ストリーミング | ○ | ○ |
| 構造化出力（`response_schema` / `output_schema`） | ○ | ○ |
| 埋め込み、バッチ、コンテキストキャッシュ | ○ | （SDK を直接使う） |
| ツール呼び出し | △ ループを自作 | ○ 組み込み |
| 複数エージェントの連携（委譲 / agent-as-tool） | ✕ 自作 | ○ `sub_agents` / `AgentTool` |
| 決まった順序での実行 | ○ 自分で書く | ○ `SequentialAgent` / `ParallelAgent` / `LoopAgent` |
| セッションと状態の保持 | ✕ 自作 | ○ `SessionService` / `State` |
| 横断的なフック（入力検査、監査、コスト計測） | ✕ 呼び出し箇所ごとに実装 | ○ コールバック |
| 評価ハーネス（回帰確認） | ✕ 自作 | ○ 評価セット、実行経路の評価 |
| 開発時のトレース UI | ✕ | ○ `adk web` |
| MCP / 外部エージェント連携 | ✕ 自作 | ○ |
| 人手の承認を挟む処理 | ✕ 自作 | ○ 長時間実行ツール |

「✕ 自作」の欄が、**将来 ADK を検討する理由になる項目**である。

---

## 4. ADK を検討すべきケース

「将来どうなったら ADK か」への回答。**該当が 1 つなら様子見、2 つ以上なら移行を検討**という目安で読める。

### 4.1 ツールの往復が 3 回以上になった

**症状**: `while` ループの中の例外処理と打ち切り条件が増えてきた。ツールが並列で返るケースに対応し始めた。

自作ループは 1〜2 往復なら簡単だが、往復が増えるほど「モデルが何をしようとしているか」を追う難易度が上がる。
ADK に移すと、この部分がゼロ行になる。**最も分かりやすい移行タイミング。**

### 4.2 プロンプトが肥大化し、役割を分けたくなった

**症状**: 1 つの `instruction` が長大になり、「分析もして、文章も書いて、形式も守って」と詰め込んでいる。
片方を直すともう片方の品質が落ちる。

役割ごとにエージェントを分けると、それぞれのプロンプトが短く保守可能になる。
本リポジトリの構成（`analyst` が分析し、`proposal_writer` が執筆する）がこの形である。

```python
root = LlmAgent(
    name="orchestrator", model=MODEL, instruction="...",
    tools=[AgentTool(agent=analyst_agent)],   # 道具として呼ぶ（制御が戻る）
    sub_agents=[proposal_writer_agent],       # 委譲する（文脈を引き継ぐ）
)
```

### 4.3 会話・複数ターンの状態を持つようになった

**症状**: 「さっきの提案の 2 番目を直して」「前回の分析を使い回して」といった要求が出てきた。

SDK 単体だと、履歴の保持・受け渡し・永続化をすべて自作することになる。
特に **Gemini 3 系では thought signature を含む会話履歴をそのまま渡す必要がある**ため、
自前で履歴を要約・切り詰めする実装は壊れやすい（[要点版 第7章](./gemini-enterprise-agent-platform.md)）。
ADK の `Session` / `State` はここを担当する。

### 4.4 横断的な制御を入れたくなった

**症状**: 「入力に個人情報が含まれていたらマスクする」「出力を検証してから返す」「1 リクエストあたりのトークン数を記録する」
といった要件が、複数の呼び出し箇所に散らばり始めた。

SDK だと呼び出し箇所ごとに書くことになり、追加漏れが起きる。
ADK のコールバック（モデル呼び出しの前後、ツール実行の前後）なら**一箇所に集約**できる。
ガードレールと監査が要件に入るなら、これは強い動機になる。

### 4.5 品質評価を継続的に回す必要が出た

**症状**: モデルを更新するたび（2.5 Flash → 3.7 Flash など）に、出力品質の回帰確認を手作業でやっている。

ADK には評価セットを定義して回すハーネスがあり、最終出力だけでなく
**「どのツールをどの順で呼んだか（実行経路）」も評価対象にできる**。
モデル更新を継続的に行う前提なら、ハーネスがある側が明確に有利。

### 4.6 人手の承認を処理の途中に挟む

**症状**: 「BigQuery への書き戻しは、担当者が承認してから実行する」のような要件。

処理を中断して外部の応答を待ち、再開する形が必要になる。ADK は長時間実行ツールとしてこの形を扱える。
SDK だと、中断状態の保持と再開を自前で設計することになる。

### 4.7 外部のツールやエージェントに繋ぐ

**症状**: MCP サーバー経由で社内システムのツールを使いたい。他チームが作ったエージェントを呼びたい。

ADK は MCP や他エージェントとの連携を前提に作られている。SDK 単体では接続層を自作する。

### 4.8 運用者が挙動を追える必要が出た

**症状**: 「なぜこの提案になったのか」を説明できない。問い合わせのたびにログを追っている。

ADK は開発時のトレース UI（`adk web`）と、実行経路のイベント記録を持つ。
**業務プロセスに組み込むなら、この可観測性は要件になりやすい。**

---

## 5. ADK を使わないほうがいいケース

公平のために、逆方向も明記する。

| ケース | 理由 |
|---|---|
| 1 回の呼び出しで終わる処理（要約、分類、抽出、翻訳、定型文生成） | ADK の抽象化が純粋なオーバーヘッドになる |
| バッチで大量に回す処理 | 制御はこちらで持ちたい。エージェントの判断は不要 |
| レイテンシがシビアな処理 | 往復とオーケストレーションの分だけ遅くなる |
| 依存を最小限にしたい | ADK は変化が速く、バージョン追従のコストがかかる |
| 処理順が完全に決まっている | `SequentialAgent` を使うより、Python で書いたほうが読みやすいことがある |

**最後の項目は特に重要。** 「順番が決まっているだけ」なら、Python の関数を順に呼ぶほうが単純である。
ADK が効くのは**順番や回数がモデルの判断で変わる**場合。

---

## 6. 今 SDK で始めるときに、将来 ADK へ移りやすくする書き方

**この 4 つを守れば、移行時に書き直すのは「呼び出しループ」だけになる。**
プロンプトとツールの実装は、そのまま ADK に渡せる。

### 6.1 ツールは型ヒントと docstring 付きの純粋な関数にする

ADK は**型ヒントと docstring からツールのスキーマを生成する**。最初からこの形で書いておけば、
`tools=[...]` に渡すだけで済む。

```python
def get_purchase_history(customer_id: str) -> list[dict]:
    """指定した顧客の購買履歴を取得する。

    Args:
        customer_id: 顧客ID（例: "C001"）。

    Returns:
        購買レコードのリスト。
    """
    return store.get_purchases(customer_id)
```

docstring は**モデルがそのツールをいつ使うか判断する材料**になるので、SDK 段階でも書いておいて損はない。

### 6.2 構造化出力は Pydantic モデルで定義する

同じクラスが SDK の `response_schema` にも ADK の `output_schema` にも渡せる。

### 6.3 プロンプトをコードから分離する

定数か別ファイルに出しておく。ADK の `instruction` にそのまま移せる。

### 6.4 履歴の管理をビジネスロジックから分離する

会話履歴を扱う処理を 1 箇所にまとめておくと、ADK の `Session` に置き換える際の影響範囲が閉じる。

---

## 7. 判断フロー

```
モデルの呼び出しは 1 回で終わるか？
  ├─ はい ─────────────────────────────────► SDK
  └─ いいえ
       │
       処理の順序と回数を、こちらで固定できるか？
         ├─ はい ──► Python で順に呼ぶ（SDK）
         │            ※ 第 5 章のとおり、順番が決まっているだけなら ADK は不要
         └─ いいえ（モデルに判断させる）
              │
              第 4 章の該当が 1 つだけか？
                ├─ はい ──► SDK のまま。第 6 章の書き方で備える
                └─ 2 つ以上 ──────────────► ADK
```

---

## 8. 本リポジトリでの実例

`agent/proposal-sample` は **ADK を使った側**の例である。SDK 単体との違いが実コードで確認できる。

| ADK の機能 | 該当箇所 |
|---|---|
| エージェント定義 | `proposal_app/agent.py`（`LlmAgent`） |
| agent-as-tool（道具として呼ぶ） | `AgentTool(agent=analyst_agent)` |
| サブエージェント（委譲する） | `sub_agents=[proposal_writer_agent]` |
| 関数ツール | `proposal_app/tools.py`（型ヒント + docstring の通常の関数） |
| 決まった順序での実行 | `server/pipeline.py`（`SequentialAgent`） |
| 構造化出力 | `proposal_app/schemas.py`（`ProposalOut`） |
| 評価 | `eval/run_eval.py` |
| 開発 UI | `adk web` |

注目すべきは `server/pipeline.py` で、**Web ダッシュボードからは順序を固定した `SequentialAgent`（分析 → 執筆）を使い、
`adk web` からの対話では判断を伴う `root_agent` を使う**という使い分けをしている。
同じツールとプロンプトを、用途に応じて 2 通りの流し方で使っている形である。

---

## 参考リンク

- [Agent Development Kit ドキュメント](https://google.github.io/adk-docs/)
- [Google Gen AI SDK 概要](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/sdks/overview)
- 実装例: [`agent/proposal-sample`](../README.md)
