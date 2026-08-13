# コード逐行解説（CODE_WALKTHROUGH）

`docs/TUTORIAL.md`（設計思想）の**詳細版**です。ソースを**上から順に、行・ブロック単位**で読み解きます。
コードを実際に開きながら読むことを想定しています。

**読み方の方針**
- **バックエンド（Python / ADK）**: ほぼ行単位で解説（最も学びが多い部分）。
- **フロントエンド（JS/HTML/CSS）**: 関数・ブロック単位で、要点行を引用して解説。
- 引用は原則そのまま。`# ←` は解説用にこの文書で付けた注記です。

## 読む順番（依存の浅い順）

1. `proposal_app/store.py` … データ層
2. `proposal_app/config.py` / `schemas.py` … 設定・スキーマ
3. `proposal_app/tools.py` … FunctionTool
4. `proposal_app/sub_agents/*` … analyst / proposal_writer
5. `proposal_app/agent.py` … 会話型 orchestrator（adk web 用）
6. `server/pipeline.py` … Web用パイプライン（生成/再提案/ストリーミング/会話）
7. `server/main.py` … FastAPI（全体制御）
8. `eval/run_eval.py` … 評価
9. `web/*` … フロントエンド
10. `Dockerfile`

---

## 1. `proposal_app/store.py` — データ層

BQ/GCS の代わりに、プロセス内メモリでデータを保持します。

```python
_DB_PATH = Path(__file__).resolve().parent.parent / "mock" / "db.json"   # (22)
_lock = threading.Lock()                                                 # (23)
_data: dict | None = None                                                # (24)
```
- **(22)** 種データのパス。`__file__`＝この store.py の絶対パス、`.parent.parent`＝`proposal_app/` の親＝リポジトリ直下。そこから `mock/db.json`。**カレントディレクトリに依存しない**書き方。
- **(23)** 書き込み（作成/更新）を排他制御するためのロック。FastAPI は複数リクエストを並行処理しうるので、`append` や id 採番の競合を防ぐ。
- **(24)** メモリ上の全データ。最初は `None`（未ロード）。

```python
def _ensure() -> None:                                                    # (27)
    global _data
    if _data is None:
        with open(_DB_PATH, encoding="utf-8") as f:                       # (30)
            _data = json.load(f)
        for key in ("customers", "products", "purchases", "drafts", "proposals", "versions"):
            _data.setdefault(key, [])                                     # (33)
```
- **(27)** 遅延ロード（lazy load）。最初のアクセス時に一度だけ db.json を読む。以後はメモリを使う。
- **(30)** `encoding="utf-8"` は日本語データのために必須。
- **(33)** 期待するキーが無くても空リストで初期化 → 後続コードが `KeyError` にならない安全策。

```python
def _next_id(items: list[dict]) -> int:                                   # (36)
    ids = [i.get("id") for i in items if isinstance(i.get("id"), int)]
    return (max(ids) + 1) if ids else 1
```
- **(36)** id 自動採番。既存の整数idの最大+1、無ければ1。json-server の挙動を踏襲。

```python
def get_customer(customer_id: str) -> dict | None:                        # (48)
    _ensure()
    return next((c for c in _data["customers"] if str(c.get("id")) == str(customer_id)), None)
```
- **(48)** ジェネレータ式＋`next(..., None)` で「最初に一致した1件、無ければ None」。`str(...)==str(...)` で型のゆらぎ（"C001" と C001 等）を吸収。
- `list_customers` / `list_products` / `get_purchases` / `list_proposals` も同じ発想（`list(...)` で**コピーを返す**のがポイント＝呼び出し側が中身を壊しても内部状態が汚れない）。

```python
def create_proposal(rec: dict) -> dict:                                   # (87)
    _ensure()
    with _lock:                                                           # (89)
        rec = dict(rec)                                                   # (90)
        rec["id"] = _next_id(_data["proposals"])
        _data["proposals"].append(rec)
        return rec
```
- **(89)** ロック内で「id採番→追加」を一括 → 並行リクエストでも id 重複しない。
- **(90)** `dict(rec)` で引数を浅いコピー。呼び出し側の辞書を書き換えない（副作用回避）。
- `create_draft` / `create_version` も同型。`update_proposal`（96-105）は一致するidを探して**丸ごと差し替え**、無ければ `None`。

> **設計の要**: BQ/GCS/Firestore に差し替えるとき、変えるのは**この関数群の中身だけ**。tools.py・main.py・UI は無改修（＝層の分離）。

---

## 2. `proposal_app/config.py` と `schemas.py`

```python
# config.py
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
```
- 使用モデルIDを環境変数で差し替え可能に。既定は `gemini-3.5-flash`。

```python
# schemas.py
class ProposalOut(BaseModel):
    title: str = Field(description="提案のタイトル（1行、訴求力のあるもの）")
    body: str = Field(description="提案本文（3〜5文。…）")
    recommended_product_ids: list[str] = Field(description='推奨する商品IDのリスト（例: ["P300", "P500"]）')
```
- **Pydantic モデル**。これを ADK の `output_schema` に渡すと、LLM が**必ずこの形のJSON**を返すよう制御される。
- `Field(description=...)` の説明は**LLMへのヒント**にもなる（各項目に何を入れるべきか）。

---

## 3. `proposal_app/tools.py` — FunctionTool

`store` を薄くラップし、**LLMの道具**であり**アプリのデータAPIの実体**でもある関数群。

```python
def get_customer_detail(customer_id: str) -> dict:
    """指定した顧客IDの詳細を取得する（BQの customers テーブル相当）。
    Args:
        customer_id: 顧客ID（例: "C001"）。
    Returns:
        顧客1件の詳細レコード。存在しない場合は {"error": ...}。
    """
    c = store.get_customer(customer_id)
    return c if c else {"error": f"customer_id={customer_id} が見つかりません"}
```
- **docstring と型ヒントが、そのまま LLM に渡る「道具の説明書」**。ADK が自動で FunctionTool 化する際、これを読んでLLMが「いつ・どの引数で呼ぶか」を決める。だから丁寧に書く。
- 戻り値は **JSONシリアライズ可能**な dict / list であること。
- 失敗時に例外を投げず `{"error": ...}` を返すのは、LLMが状況を理解して次の行動を選べるようにするため。

```python
def save_draft_to_gcs(customer_id, title, body, recommended_product_ids) -> dict:
    saved = store.create_draft({... "status": "draft"})
    return {"draft_id": saved.get("id"), "saved": saved}
```
- 命名 `..._to_gcs` / `..._to_bq` は「本来どのGCPサービスに対応するか」を**教材的に明示**（中身は今は store）。
- `write_proposal_to_bq`（新規INSERT相当）と `update_proposal_in_bq`（UPDATE相当）が対。後者は `store.update_proposal` が `None` を返したら `{"error": ...}`。

---

## 4. `proposal_app/sub_agents/*` — 2つのエージェント

### analyst.py（分析専門）

```python
analyst_agent = LlmAgent(
    name="analyst",
    model=MODEL,
    description="…分析専門エージェント。",     # ← 他エージェントから見た「何ができるか」
    instruction="""あなたは優秀なB2Bデータアナリストです。
… 1. get_customer_detail … 2. get_purchase_history … 3. list_products …
… 提案文そのものは書かないこと。""",           # ← このエージェント自身への行動指示
    tools=[get_customer_detail, get_purchase_history, list_products],
)
```
- `description` と `instruction` の役割の違いに注目：前者は**外から見た能力**（委譲/呼び出しの判断材料）、後者は**中の行動規範**。
- `tools=[...]` に関数を**そのまま**渡す＝ADKがFunctionTool化。
- 「提案文は書くな、分析に徹しろ」と**役割を絞る**ことで、後段の proposal_writer と責務が分離。

### proposal_writer.py（提案作成）

`server/pipeline.py` 側で構造化版を使うため、`sub_agents/proposal_writer.py` は
`adk web`（会話型 orchestrator）用。委譲されると直前の会話（分析結果）を引き継いで提案を書く。

---

## 5. `proposal_app/agent.py` — 会話型 orchestrator（adk web 用）

```python
root_agent = LlmAgent(
    name="orchestrator",
    model=MODEL,
    instruction="""… 2. analyst ツールを呼び … （Toolエージェント）
    3. proposal_writer に処理を委譲(transfer) … （サブエージェント）
    5. …「承認」…write_proposal_to_bq…""",
    tools=[
        list_customers,
        AgentTool(agent=analyst_agent),   # (46) ← ① Toolエージェント（agent-as-tool）
        save_draft_to_gcs, load_draft_from_gcs, write_proposal_to_bq,
    ],
    sub_agents=[proposal_writer_agent],   # (51) ← ② サブエージェント（委譲）
)
```
- **(46) AgentTool** … analyst を「道具」として呼ぶ。呼ぶと結果が返り、制御は自動で orchestrator に戻る。
- **(51) sub_agents** … proposal_writer に「処理そのもの」を委譲（transfer）。会話コンテキストを引き継ぐ。
- **制約**: 同じインスタンスを AgentTool と sub_agents の両方に入れると親が二重になる。だから analyst は AgentTool 専用、proposal_writer は sub_agent 専用。
- `adk web` / `adk run` は**このモジュールの `root_agent`** を探して起動する。

> Web UI（`server/pipeline.py`）はこの会話型とは**別経路**。次章の決定論パイプラインを使う。

---

## 6. `server/pipeline.py` — Web用パイプライン（生成・再提案・ストリーミング・会話）

### エージェントの組み立て（`_build_analyst` / `_build_proposal_writer`）

```python
def _build_analyst(name="analyst_web") -> LlmAgent:
    return LlmAgent(
        ...,
        instruction="""【最重要・言語ルール】… 思考も回答もすべて日本語だけ …""",  # ← 冒頭に言語ルール
        tools=[get_customer_detail, get_purchase_history, list_products],
        output_key="analysis",                                   # 出力を state["analysis"] へ
        generate_content_config=types.GenerateContentConfig(     # ← 思考(thinking)を有効化
            thinking_config=types.ThinkingConfig(
                include_thoughts=True, thinking_level="high"
            )
        ),
    )

def _build_proposal_writer(name="proposal_writer_web") -> LlmAgent:
    return LlmAgent(
        ...,
        instruction="""【最重要・言語ルール】… 思考文をJSON本文に混ぜないこと …""",
        output_schema=ProposalOut,                               # 構造化JSONで固定
        output_key="proposal",
        generate_content_config=types.GenerateContentConfig(     # ← ここも思考を有効化
            thinking_config=types.ThinkingConfig(
                include_thoughts=True, thinking_level="high"
            )
        ),
    )
```
- **ファクトリ関数**にしているのは、同じ構成のエージェントを**別インスタンス**で複数作るため（後述の親重複回避）。
- **output_key** … そのエージェントの最終出力を `session.state[キー]` に保存。次段が読める。
- **output_schema** … 提案を**構造化JSON**で固定。**この指定があるとツール/委譲は使えない**（構造化出力との排他）。
- **言語ルールを instruction の冒頭に前置き** … 「思考（reasoning/thinking）も回答も**すべて日本語だけ**、英語禁止」を最初に宣言。Gemini は放っておくと内部推論を英語で行いがちなので、思考を表示する本アプリでは冒頭で強く縛る。proposal_writer 側には加えて「**思考の文章を JSON 本文（title/body/…）に混ぜない**」注記を入れている。
- **思考(thinking)の有効化** … `ThinkingConfig(include_thoughts=True, thinking_level="high")` で Gemini の内部推論を**別パート**として受け取れるようにする（各パートは `part.thought=True` で本文と区別できる）。`thinking_level="high"` はより深く推論させる指定（その分やや遅くなる）。
- **proposal_writer も思考を有効化**した点に注目：`output_schema`（構造化JSON）と併用できる。**本文＝JSON**、**思考＝`part.thought=True` の別パート**として分離して流れるので、JSON の形は壊れない。これで分析フェーズだけでなく**提案フェーズの思考**も UI に出せる。

```python
proposal_pipeline = SequentialAgent(
    name="proposal_pipeline",
    sub_agents=[_build_analyst(), _build_proposal_writer()],  # 上から順に実行
)
proposal_refiner = _build_proposal_writer(name="proposal_refiner")  # 再提案用は別個体
_pipeline_runner = InMemoryRunner(agent=proposal_pipeline, app_name=APP_NAME)
_refine_runner  = InMemoryRunner(agent=proposal_refiner,  app_name=APP_NAME)
```
- **SequentialAgent** … 子を順に実行する決定論エージェント。analyst→proposal_writer を必ずこの順で。
- 再提案用に**別インスタンス**を作る理由：`proposal_pipeline` 内の proposal_writer は既に「親（パイプライン）」を持つ。同じ個体を別Runnerのトップに置くと親が衝突するため、作り直す。
- **InMemoryRunner** … エージェントを実行する器。セッション管理もこの中。

### 実行ヘルパ（`_run_in_session` / `_run`）

```python
async def _run_in_session(runner, session_id, text) -> tuple[dict, str]:
    message = types.Content(role="user", parts=[types.Part(text=text)])
    thinking_acc = ""
    async for event in runner.run_async(user_id=USER_ID, session_id=session_id, new_message=message):
        if getattr(event, "content", None) and event.content.parts:
            for part in event.content.parts:
                if getattr(part, "thought", False) and getattr(part, "text", None):
                    thinking_acc += part.text            # ← 思考パートだけ集約
    final = await runner.session_service.get_session(...)
    return final.state, thinking_acc                     # (最終state, 思考テキスト)
```
- 「既存セッションに1メッセージ流す」。会話継続（同じ session_id を使い回す）で使う。
- **戻り値がタプル `(state, thinking)` に変わった**：非ストリーミングでもイベントを走査し、`part.thought=True` のテキストだけを結合して**思考**を返す。思考を有効化していないエージェントでは空文字になる。
- `_run` は「新規セッションを作って `_run_in_session`」＝単発実行。こちらも `(state, thinking)` を返す。

### 会話の継続（`_conversations` / `reset_conversation` / `_ensure_refine_session` / `refine_proposal`）

```python
# 単一ユーザー前提。プロセス共有のグローバルで、キーは customer_id のみ。
_conversations: dict[str, str] = {}                            # 顧客ID → セッションID

def reset_conversation(customer_id):
    _conversations.pop(customer_id, None)
```
- 顧客ごとに会話セッションIDを保持。これが「過去の指示を覚える」鍵。
- コメントで**単一ユーザー前提**を明示：このマップも store もプロセス共有なので、同じ顧客を複数ユーザーが同時操作すると会話が混線し得る。多人数対応するなら `(user_id, customer_id)` をキーにし、store も外部（Firestore 等）へ切り出す必要がある——という割り切りを注記している。

再提案は「セッション取得」と「プロンプト組み立て」を**ヘルパに分離**した：

```python
async def _ensure_refine_session(customer_id) -> tuple[str, bool]:
    is_first_turn = customer_id not in _conversations
    if is_first_turn:
        session = await _refine_runner.session_service.create_session(...)
        _conversations[customer_id] = session.id           # セッションを記憶
    return _conversations[customer_id], is_first_turn

def _refine_prompt(customer_id, analysis, previous_proposal, instruction, is_first_turn) -> str:
    if is_first_turn:
        return f"""…# 分析結果 {analysis} # 現在の提案(JSON) {prev} # 今回の指示 {instruction}"""
    return f"""これまでの会話を踏まえて…# 現在の提案(JSON) {prev} # 今回の指示 {instruction}"""

async def refine_proposal(customer_id, analysis, previous_proposal, instruction) -> dict:
    session_id, is_first_turn = await _ensure_refine_session(customer_id)
    text = _refine_prompt(customer_id, analysis, previous_proposal, instruction, is_first_turn)
    state, thinking = await _run_in_session(_refine_runner, session_id, text)  # 同じセッションで継続
    return {"analysis": analysis, "proposal": _parse_proposal(...), "thinking": thinking}
```
- **`_ensure_refine_session`** … その顧客の初回なら新規セッションを作って記憶し、`(session_id, 初回か)` を返す。作ったセッションIDを覚える → 次回の refine が同じ会話を継続。
- **`_refine_prompt`** … 初回だけ分析を文脈に入れ、2回目以降は「現在の提案＋指示」だけ（過去はセッション履歴に残っている）。この分岐をヘルパに切り出したことで、後述の**ストリーミング版と本文組み立てを共有**できる。
- `refine_proposal` は上の2ヘルパ＋`_run_in_session` を使う形に整理され、戻り値に **`thinking`（そのターンの思考）** が加わった。`_run_in_session` に**同じ session_id** を渡すのがミソ。ADKがセッションに会話履歴を積むので、エージェントは「さっき外した商品」等を覚えている。
- `generate_proposal` は先頭で `reset_conversation` を呼ぶ＝**新規生成は新しい土台**。戻り値にも `thinking` を追加。

### ストリーミング生成（`generate_proposal_stream`）

```python
cfg = RunConfig(streaming_mode=StreamingMode.SSE)
async for event in _pipeline_runner.run_async(..., run_config=cfg):
    author = getattr(event, "author", "")
    fcs = event.get_function_calls() if hasattr(event, "get_function_calls") else []
    if fcs:
        yield {"type": "status", "text": "顧客データを取得中…（" + ... + "）"}   # ツール実行を通知
        continue
    partial = getattr(event, "partial", None)
    for part in event.content.parts:
        t = getattr(part, "text", None)
        if not t: continue
        is_thought = getattr(part, "thought", False)
        # 提案フェーズの「本文(構造化JSON)」は逐次表示しない（最初に一度だけ通知）
        if author == "proposal_writer_web" and not is_thought:
            if not proposal_notified:
                proposal_notified = True
                yield {"type": "status", "text": "分析完了。提案を作成中…"}
            continue
        if not partial: continue                             # 差分(partial)だけ流す
        if is_thought:
            yield {"type": "thinking_delta", "text": t}      # ← 思考（分析・提案 両フェーズ）
        else:
            yield {"type": "analysis_delta", "text": t}      # 分析の本文
…
final = await _pipeline_runner.session_service.get_session(...)
yield {"type": "final", "analysis": …, "proposal": _parse_proposal(...), "thinking": thinking_acc}
```
- `streaming_mode=SSE` を指定すると、`run_async` が**トークンの差分イベント**も流す。
- **重要な発見**（実機確認済み）: `partial=True` イベントは**差分テキスト**、`partial=False` は**累積**。だから `partial` の差分だけを送り、二重表示を防ぐ。
- ツール呼び出しイベントは `get_function_calls()` で拾い、「取得中」ステータスに。
- **思考パート（`part.thought=True`）は分析・提案の両フェーズとも `thinking_delta` として流す**のが今回の追加点。一方、proposal_writer の**本文（構造化JSON）は逐次表示せず**、最初に一度だけ「作成中…」ステータスを出すだけ（JSON の断片を UI に見せない）。分析の本文だけが `analysis_delta` で逐次表示される。
- 最終値は途中の差分ではなく **state から確定取得**し、`thinking`（集約した思考）も添えて `final` で返す。この非同期ジェネレータを main.py がSSEに変換する。

### 再提案のストリーミング（`refine_proposal_stream`）

`generate_proposal_stream` と同形の**新設**非同期ジェネレータ。再提案でも思考をライブ表示できるようにした。

```python
async def refine_proposal_stream(customer_id, analysis, previous_proposal, instruction):
    session_id, is_first_turn = await _ensure_refine_session(customer_id)   # 会話を継続
    text = _refine_prompt(customer_id, analysis, previous_proposal, instruction, is_first_turn)
    cfg = RunConfig(streaming_mode=StreamingMode.SSE)
    yield {"type": "status", "text": "指示を反映して再提案中…"}
    async for event in _refine_runner.run_async(..., run_config=cfg):
        for part in event.content.parts:
            # 思考(part.thought)の差分だけライブ配信。本文(構造化JSON)は流さない。
            if getattr(part, "thought", False) and partial:
                yield {"type": "thinking_delta", "text": part.text}
    final = await _refine_runner.session_service.get_session(...)
    yield {"type": "final", "analysis": analysis, "proposal": _parse_proposal(...), "thinking": thinking_acc}
```
- `_ensure_refine_session` と `_refine_prompt` を**非ストリーム版と共有**（会話の継続もそのまま効く）。
- 流すのは `status` → **`thinking_delta`（思考の差分のみ）** → `final`。提案本文は構造化JSONなので途中は流さず、`final` で確定値（`proposal`＋集約した `thinking`）を返す。分析は据え置き（再提案では再計算しない）。

---

## 7. `server/main.py` — FastAPI（全体制御）

### 起動時の初期化（13-46）

```python
_ENV = Path(__file__).resolve().parent.parent / "proposal_app" / ".env"   # (25)
if _ENV.exists():
    load_dotenv(_ENV)                                                     # (27)
…
from proposal_app import store, tools                                     # (34) ← .env 読込“後”に import
from server.pipeline import (generate_proposal, generate_proposal_stream,
                             refine_proposal, refine_proposal_stream)      # ← refine_stream も追加
…
APP_PASSWORD = os.getenv("APP_PASSWORD")                                  # (44)
app = FastAPI(title="顧客提案ジェネレーター")                              # (46)
```
- **(25-27)** ローカルは `.env` を読む。Cloud Run では環境変数を直接渡すので `.env` は無くてよい（`exists()` で分岐）。
- **(34)** import が `# noqa: E402`（module-levelでない位置のimport警告を抑制）付きで**後半**にあるのは、**Vertex系の環境変数を load_dotenv で入れてから** ADK 系を import したいため。
- **(44)** `APP_PASSWORD` が設定されていれば認証を有効化（未設定ならノーガード＝ローカル開発が楽）。

### gatekeeper ミドルウェア（49-70）

```python
@app.middleware("http")
async def gatekeeper(request, call_next):
    if APP_PASSWORD:                                            # (52) 設定時のみ
        ok = False
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            _, pw = base64.b64decode(header[6:]).decode("utf-8").split(":", 1)  # (57)
            ok = secrets.compare_digest(pw, APP_PASSWORD)        # (58) タイミング攻撃対策
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="proposal"'})  # (62)
    response = await call_next(request)                          # (67)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-store"           # (69)
    return response
```
- **(57)** `Authorization: Basic <base64(user:pass)>` を復号し、`:` で1回だけ分割（パスワードに `:` が含まれても後半を取れる）。
- **(58)** `compare_digest` で**比較時間を一定に**（`==` だと文字一致数で処理時間が変わり、総当たりのヒントになる）。
- **(62)** 認証失敗は 401＋`WWW-Authenticate` → ブラウザがログインダイアログを出す。
- **(67-69)** 認証を通過した後、`/` と `/static/*` には `no-store` を付けて**UI編集の即反映**を保証（開発用）。
- ⚠️ 注意点: `@app.middleware("http")` は Starlette の BaseHTTPMiddleware。SSE（`/api/generate_stream`）がバッファされないか懸念があったが、**実機（curl -N）で差分が逐次届くことを確認済み**。

### リクエストモデルと版記録（73-104）

```python
class ApproveReq(BaseModel):
    …
    proposal_id: int | None = None       # (91) あり=更新 / なし=新規

def _record_version(customer_id, source, analysis, proposal, thinking="") -> dict:
    return store.create_version({… "thinking": thinking or "",
                                 "created_at": datetime.now().isoformat(timespec="seconds")})
```
- **(91)** Pydantic が入力を自動検証。`proposal_id` の有無で新規/更新を分岐する材料。
- 版に時刻を刻む。`datetime.now()` はサーバ実行時なので普通に使える（※ワークフローのJSサンドボックスとは別物）。
- **引数 `thinking` を追加**：生成/再提案のたびにモデルの思考も版に保存する（履歴からの復元で当時の思考も戻せる）。呼び出し側（`api_generate` / `api_refine` / 各ストリーミング）が `result["thinking"]` を渡す。

### データAPI（109-141）
- `/api/customers`・`/api/products`・`/api/proposals?customer_id=`・`/api/versions?customer_id=` … いずれも `tools`/`store` を返すだけ＝**LLM非経由・無料・高速**。
- `/api/customers/{id}`（114）は存在しなければ `HTTPException(404)`。

### 生成API（146-163）と副作用の回収

```python
@app.post("/api/generate")
async def api_generate(req):
    result = await generate_proposal(req.customer_id)      # ← LLM（分析→提案）
    proposal = result.get("proposal") or {}
    thinking = result.get("thinking", "")                   # 思考も受け取る
    draft = tools.save_draft_to_gcs(...)                    # 下書き保存（GCS相当）
    version = _record_version(req.customer_id, "generate", …, proposal, thinking)  # 版を記録
    return {"analysis": …, "proposal": …, "thinking": thinking, "draft_id": …, "version_id": …}
```
- **設計の型**: 「LLMは考えるだけ（分析・作文）」「保存等の**副作用はアプリ側**」。`output_schema` のエージェントはツールを使えないので、下書き保存・版記録はここで行う。
- **`thinking` をレスポンスに追加**：`generate_proposal` の戻り値から思考を取り出し、`_record_version` へ渡して版に保存し、JSON でもフロントに返す。`/api/refine`（非ストリーム）も同じ形で `thinking` を返す。

### ストリーミングAPI（`/api/generate_stream` と `/api/refine_stream`）

```python
def _sse(event, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

@app.post("/api/generate_stream")
async def api_generate_stream(req):
    async def event_gen():
        try:
            async for msg in generate_proposal_stream(req.customer_id):  # pipelineのジェネレータ
                if msg["type"] == "final":
                    … draft保存 / _record_version（thinking も渡す） …    # 副作用は最後に
                    yield _sse("done", {…, "thinking": thinking})        # done で確定値
                else:
                    yield _sse(msg["type"], msg)   # status/analysis_delta/thinking_delta をそのまま流す
        except Exception as e:
            yield _sse("error", {"text": str(e)})
    return StreamingResponse(event_gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```
- SSEの1メッセージ形式：`event:` 行＋`data:` 行＋空行。JSONは `\n` を含まないよう**1行に**エンコード（`json.dumps` は改行を `\n` に）。
- pipeline の非同期ジェネレータを**そのまま**消費し、SSEに変換して yield。今回から `thinking_delta` も透過的に流れ（`else` 節でそのまま転送）、`final` 受信時は下書き保存＋版記録（`thinking` も保存）してから `done` で `thinking` 込みの確定値を返す。
- `text/event-stream`＋バッファ抑止ヘッダ。フロントは fetch のストリームで受ける。

**新設 `/api/refine_stream`** … `refine_proposal_stream` を SSE 配信する、`generate_stream` と**同形**のエンドポイント。`status`/`thinking_delta` をそのまま流し、`final` を受けたら同様に下書き保存＋版記録して `done` を返す。これで再提案も「考えている様子（思考）」をライブ表示できるようになった（従来の `/api/refine` は非ストリームで残置）。

### 承認API（231-）と静的配信（末尾）

```python
@app.post("/api/approve")
def api_approve(req):
    if req.proposal_id is not None:
        return tools.update_proposal_in_bq(proposal_id=str(req.proposal_id), …)  # 更新(PUT相当)
    return tools.write_proposal_to_bq(…)                                          # 新規(INSERT相当)
…
@app.get("/")
def index(): return FileResponse(WEB_DIR / "index.html")
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
```
- `proposal_id` の有無で更新/新規を自動分岐（重複を作らない）。
- `/` で index.html、`/static/*` で web/ 配下（JS/CSS/画像）を配信。フロントは**同一オリジン**なので CORS 不要。

---

## 8. `eval/run_eval.py` — 提案品質の自動評価

```python
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # Windows cp932での絵文字/日本語クラッシュ回避
except Exception:
    pass

class Judgement(BaseModel):
    grounding: int; relevance: int; actionability: int; reason: str   # 審査結果の構造化スキーマ

judge_agent = LlmAgent(..., output_schema=Judgement, output_key="judgement")  # 審査員もADKのLlmAgent
```
- **審査員（LLM-as-judge）も ADK の `LlmAgent`＋`output_schema`** で作る＝本アプリの技術がそのまま評価にも使える。
- `CASES` … ダミーデータの状況に基づく期待（例: C005 は容量上限→P300 を含むべき）。
- `rule_checks()` … 決定論チェック（title/body非空、商品IDの妥当性、期待商品を含むか）。
- `main()` … 各ケースで実パイプラインを回し、ルール違反ゼロ＆judge平均≥3.5 で PASS。全PASSで終了コード0（CI可）。

---

## 9. `Dockerfile` — Cloud Run 用

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt        # 依存を先に入れてレイヤキャッシュを効かせる
COPY . ./
ENV PORT=8080
CMD exec uvicorn server.main:app --host 0.0.0.0 --port ${PORT}   # Cloud Runが注入する$PORTで待受
```
- `COPY requirements.txt` → `pip install` → `COPY . .` の順は**Dockerレイヤキャッシュ最適化**（コードだけ変えた時に再インストールを避ける）。
- `--host 0.0.0.0` でコンテナ外から到達可能に。`${PORT}` は Cloud Run が渡す。

---

## 10. フロントエンド（`web/`）

依存ライブラリゼロの素の HTML/CSS/JS。ここは**関数・ブロック単位**で解説します。

### 10-1. `web/index.html` — 骨組み

```
header.topbar
  #viewport-toggle      … モバイルだけ表示「🖥️ PC版で表示」トグル（JSが物理画面幅で判定）
  #theme-select         … テーマ切替（システム/ライト/ダーク）
main.layout             … CSS Grid（5トラック: 左 | 仕切り | 中央 | 仕切り | 右）
  section.customers     … 左: 顧客一覧（#customer-list）
  div#splitter-left     … ドラッグで幅調整 / 開閉タブ
  section.detail        … 中央
    #detail-head        … 顧客名 + ✨生成ボタン
    .cards              … 顧客属性 / 購買履歴
    .card.saved         … 保存済み提案（#saved-list）
    details.card.history … 生成履歴（既定は閉じる。#compare-box / #history-list）
    #result             … 分析 → 思考 → 提案 の順で3ブロック
        .card.analysis     … #analysis-text（分析結果）
        details#thinking-box … 🧠 モデルの思考プロセス（#thinking-text）
        .card.proposal     … 提案“編集フォーム”
          #prop-title-input / #prop-body-input / #product-palette（商品パレット）
          .refine（#refine-input / #btn-refine / #conversation-log）
          .eval-row（#btn-evaluate / #eval-result）
          .draft-row（#edit-mode-badge / #draft-badge / #btn-approve）
  div#splitter-right
  section.preview-pane  … 右: メールプレビュー（#preview-empty / #preview-content の pv-*）
#activity               … 画面固定の稼働オーバーレイ（スピナー + #activity-status）
```
- 提案は**表示専用ではなく入力フォーム**（`<input>`/`<textarea>`/商品パレット）＝手動修正できる。
- 各要素に `id` を振り、JSから参照する素朴な構成。
- **今セッションの変更**:
  - viewport メタに `id="viewport-meta"` を付け、topbar 右に**モバイル用「PC版で表示」トグル** `#viewport-toggle` を追加。
  - `#result` の並びを **分析結果カード → 🧠思考ボックス（`details#thinking-box`）→ 提案カード** に変更（思考は以前は分析の上、今は分析の下）。
  - インラインの `#generating` ブロック（スピナー＋フェーズ表示）を廃止し、**画面固定の稼働オーバーレイ** `#activity`（スピナー＋`#activity-status` だけ）に置き換え。スクロール位置に関係なく見え、生成・再提案の両方で共通。
  - 生成履歴（版）を `<div class="card history">` から **`<details class="card history">`（既定で閉じる）** に変更。

### 10-2. `web/app.js` — 状態と関数

**状態変数（冒頭）** — UI全体はこの数個で回る。
```js
let productsById = {};        // 商品ID→商品（表示用の辞書）
let currentCustomer = null;   // 選択中の顧客
let currentProposalId = null; // null=新規 / 数値=既存BQ提案を編集中（保存が新規/更新を分ける）
let currentAnalysis = "";     // 直近の分析（再提案で使い回す）
let currentOrder = [];        // 推奨商品の“表示順”（D&Dの結果＝保存順の真実）
let compareA = null;          // 版比較で1件目に選んだ版
let conversationLog = [];     // 会話の流れ: [{kind:'generate'|'refine', instruction, thinking}]
let currentThinking = "";     // 直近生成のモデル思考（版に保存/復元）
```
- **今セッションの変更**: `conversationLog` は**文字列配列**から **`{kind, instruction, thinking}` のオブジェクト配列**に拡張（ターンごとに「生成/再提案の種別」「指示」「そのターンの思考」を保持）。直近の思考を保持する `currentThinking` も追加。

**`api(path, options)`** — fetch の薄いラッパ。`res.ok` でなければ throw（呼び出し側で toast 表示）。

**`renderMarkdown(md)` / `escapeHtml(s)`** — 分析の Markdown を HTML 化。
- **急所**: `renderMarkdown` は先頭で `escapeHtml(md)` を通してから見出し/リスト/太字を変換 → `innerHTML` に入れても `<script>` は**文字として無害化**（XSS対策）。

**`init()` → `loadCustomers()`** — 起動時に商品と顧客を読み、左ペインにカードを描画。カードクリックで `selectCustomer`。

**`selectCustomer(id, el)`** — 顧客選択の中心。
- 状態リセット（`currentProposalId=null`, `currentAnalysis=""`, `conversationLog=[]`）＋プレビューをプレースホルダに戻す。
- 顧客詳細・購買履歴を `Promise.all` で並列取得して描画。
- 続けて `loadSavedProposals(id)` と `loadVersions(id)` を呼ぶ。

**`loadSavedProposals(id)`** — `/api/proposals?customer_id=` を取得し、各件に「✏️編集」ボタン → `editSavedProposal`。

**版管理: `loadVersions` / `restoreVersion` / `pickCompare` / `renderCompare`**
- `loadVersions(id)` … `/api/versions?customer_id=` を新しい順で描画。各件に「↩復元」「⇄比較」。
- `restoreVersion(v)` … `currentProposalId=null`（＝新規扱い）にして `showProposalForm` でフォームに流し込む。
- `pickCompare(v, el)` … 1件目を `compareA` に保持（ハイライト）、2件目で `renderCompare` を呼ぶ。
- `renderCompare(a, b)` … **集合演算**で商品差分を出す（追加=B−A, 削除=A−B, 共通=A∩B）＋タイトル/本文文字数の差。

**商品チェックとプレビュー: `renderProductChecks` / `getFormProposal` / `productImageSrc` / `renderPreview*`**
- `renderProductChecks()` … 全商品のチェックボックスを描画。変更時に `currentOrder` を増減し、プレビュー再描画。
- `getFormProposal()` … フォーム値を集約。`recommended_product_ids` は **`currentOrder` の順**（D&D結果が保存に反映）。
- `productImageSrc(p)` … **`p.image` があればそれ、無ければカテゴリ別SVGを自動生成**（フォールバック設計）。
- `renderPreviewProducts()` … `currentOrder` を元にタイルを描画。**HTML5 D&D**：`dragstart` で `dragIndex` 記録、`dragover` で `preventDefault()`（しないと `drop` が発火しない）、`drop` で `splice` により並べ替え→再描画。

**`renderConversationLog()`** — 会話の流れを描画。各ターンを**バッジ（生成/再提案）＋指示＋そのターンの思考の折りたたみ**（「🧠 このターンの思考プロセス」）で表示。`thinking` が空のターンは折りたたみを出さない（`conversationLog` がオブジェクト配列になったのに対応）。

**`showProposalForm(prop, opts)`** — 生成/再提案/編集/復元で共通の描画口。
- フォーム（title/body/商品）を埋め、`currentOrder` を設定、プレビュー更新。
- `opts.analysisMd` があれば Markdown 描画、`opts.analysisNote` なら注記表示。
- **`opts.thinking`** があれば `#thinking-text` に描画して思考ボックスを表示し、確定時は **`tb.open = true` で既定で開く**（無ければ隠す）。`currentThinking` にも保持。
- `updateEditBadge()` で「新規提案／編集中(id)」を表示。

**モデル稼働インジケータ: `showActivity(status)` / `setActivityStatus(text)` / `hideActivity()`**
- 画面固定オーバーレイ `#activity` の表示・文言更新・非表示。**旧 `setGenStatus` は削除**。このフロート表示は**思考テキストは出さず**、スピナー＋ステータス文言だけ（思考は `#thinking-box` 側にライブ表示する）。生成・再提案の両方で共通。

**生成（ストリーミング）: `generate()` + `parseSSEChunk()`**
```js
showActivity("生成を開始しています…");
const res = await fetch("/api/generate_stream", {method:"POST", …});   // EventSourceは不可(POST/認証)なのでfetch
const reader = res.body.getReader(); const decoder = new TextDecoder();
while (true) {
  const {done, value} = await reader.read(); if (done) break;
  buf += decoder.decode(value, {stream:true});
  while ((idx = buf.indexOf("\n\n")) >= 0) {          // SSEは空行区切り
    const {event, data} = parseSSEChunk(buf.slice(0, idx)); buf = buf.slice(idx+2);
    if (event === "thinking_delta")      { thinkingAcc += data.text; tb.open = true; #thinking-text = renderMarkdown(thinkingAcc); }
    else if (event === "analysis_delta") { analysisAcc += data.text; #analysis-text = renderMarkdown(analysisAcc); }
    else if (event === "status")         { setActivityStatus(data.text); }
    else if (event === "done")           { doneData = data; }
  }
}
showProposalForm(doneData.proposal, {analysisMd: doneData.analysis, thinking: doneData.thinking, draftId: doneData.draft_id});
conversationLog = [{ kind: "generate", instruction: "初回生成", thinking: doneData.thinking || thinkingAcc }];
renderConversationLog();
```
- `EventSource` は POST もカスタムヘッダも送れないため、**fetch + ReadableStream** で手動パース。
- `analysis_delta` を**累積**して Markdown 再描画＝逐次表示。**今回から `thinking_delta` も累積**して `#thinking-box` にライブ表示（生成中は `open=true` で「考えている様子」を見せる）。`status` は**オーバーレイ**（`setActivityStatus`）に表示。`done` で確定値をフォームに反映。
- `done` 後、`conversationLog` を **初回生成ターン**（`{kind:'generate', instruction:'初回生成', thinking}`）で開始する。

**再提案（ストリーミング）: `refine()`** — 現在の提案（手動修正込み）＋分析＋指示を **`/api/refine_stream`** に fetch + ReadableStream で送り、思考を**ライブ表示**する（従来の `/api/refine` 直叩きから変更）。`thinking_delta` を累積して `#thinking-box` に表示、`status` はオーバーレイへ。`done` で確定値をフォームに反映し、`conversationLog.push({kind:'refine', instruction, thinking})` で会話ログに**このターンの思考ごと**追加。バックエンドは同一セッションで会話を継続。

**承認: `approve()`** — `getFormProposal()` を `/api/approve` に送信。`proposal_id: currentProposalId`（null=新規/数値=更新）。保存後、返ってきた id を `currentProposalId` に入れて以後は上書き扱いに。

**ペイン幅・開閉（末尾）: `initSplitter` / `setLeftCollapsed` + localStorage**
- `initSplitter(id, varName, sign, min, max)` … `pointerdown`→`pointermove` でCSS変数（`--left-w`/`--right-w`）を書き換え、`min/max` でクランプ。離したら localStorage に保存。
- 右仕切りは符号 `-1`（右へ動かすと右ペインが縮む）。
- `setLeftCollapsed` … `.left-collapsed` を付け外し。幅・開閉状態は localStorage で次回復元。

**モバイル「PC版で表示」トグル（末尾）** — `#viewport-toggle` のロジック。
- viewport メタの `content` を **`width=device-width`（モバイル最適化）⇄ `width=1280`（デスクトップ幅相当）** で切り替える。選択は `localStorage("viewportMode")` に保持。
- トグル自体は **`window.screen.width <= 820` の端末でのみ表示**（PC/大画面では何もしない）。判定に viewport の影響を受けない `window.screen.width` を使うので、デスクトップ幅に切り替えてもリンクは消えない。

### 10-3. `web/style.css` — 要点

- **可変グリッド**: `.layout { --left-w; --right-w; grid-template-columns: var(--left-w) var(--sp) minmax(0,1fr) var(--sp) var(--right-w); }`。`.left-collapsed` で左2トラックを 0 に。
- **`minmax(0,1fr)`** の `0` が重要（中央が内容で押し広がって溢れるのを防ぐ）。
- **仕切り**: `.splitter` は幅8pxの掴み代。`::before` で中央に細い線、hover/resizing で色を変える。
- **レスポンシブ**: `@media (max-width:1200px)` で仕切りを消して2カラム＋プレビューを下に全幅（`grid-column:1/-1`）、`900px` で1カラム。
- **メールプレビュー**: `.email` は明るい紙面（ダークUIの中で“メールらしさ”を出す）。商品タイルはグラブカーソル、`dragging`/`drop-target` の視覚フィードバック。
- **テーマ変数**: 冒頭 `:root` の色変数で全体を統一。
- **今セッションで追加したスタイル**:
  - `.activity` / `.activity-card` / `#activity-status` … 画面固定の稼働オーバーレイ（`position:fixed; inset:0`、`pointer-events:none` で背後の操作を妨げない）。
  - `.viewport-toggle` … topbar のモバイル用「PC版で表示」ボタン（テーマ選択の見た目に合わせる）。
  - `.card.history > summary` … 生成履歴を折りたたみ（`details`）にした見出し（`▸`/`▾` マーカー、`thinking-box` と同系の見た目）。
  - 会話ログの**ターン内思考**: `.cl-head` / `.cl-instr` / `.cl-think` / `.cl-think-text`、および `.cl-item` を**縦積み**（`flex-direction:column`）に変更（指示行の下に折りたたみ思考を積む）。

---

## まとめ：全体をつなぐ1本の線

「✨生成」を押すと…
1. `app.js: generate()` が `POST /api/generate_stream`
2. `main.py: api_generate_stream` → `pipeline.generate_proposal_stream`（`RunConfig SSE`）
3. `SequentialAgent`（`analyst_web`→`proposal_writer_web`）が実行、analyst は `tools.py`→`store.py` を読む
4. 差分イベントを `_sse` でSSE化して逐次返す → フロントが**分析を逐次描画＋モデルの思考（thinking）をライブ表示**（ステータスは稼働オーバーレイ）
5. `final` で `store.save_draft` ＋ `store.create_version`（思考も保存）、`done` で `thinking` 込みの確定値
6. `showProposalForm` がフォーム・プレビュー・思考ボックス・履歴を更新

「🔄再提案」も同じ流れ（`refine()` → `/api/refine_stream` → `refine_proposal_stream`）で、思考をライブ表示しつつ**同一セッションで会話を継続**します。

**層がきれいに分かれている**ので、各段を独立に学び・差し替えできます（例: `store.py` を本物のBQ/GCSに、`web/` を別UIに）。
このファイルと `docs/TUTORIAL.md` を往復すると、"何を" と "なぜ" の両面から理解できます。

