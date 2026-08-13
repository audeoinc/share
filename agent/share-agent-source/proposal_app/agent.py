"""Root（Orchestrator）エージェント。

ワークフロー全体を統括するコーディネーター。ADK の2つの連携パターンを
1本のフローで学べるように構成しています。

- Toolエージェント (agent-as-tool): analyst を AgentTool として呼ぶ。
    → 道具のように呼び、結果を受け取って制御が自動で戻る。
- サブエージェント (sub_agent / transfer): proposal_writer に委譲する。
    → 会話コンテキストを引き継いで処理を任せる。

`adk web` / `adk run` はこのモジュールの `root_agent` を探して起動します。
"""
from google.adk.agents import LlmAgent
from google.adk.tools.agent_tool import AgentTool

from .config import MODEL
from .sub_agents.analyst import analyst_agent
from .sub_agents.proposal_writer import proposal_writer_agent
from .tools import (
    list_customers,
    load_draft_from_gcs,
    save_draft_to_gcs,
    write_proposal_to_bq,
)

root_agent = LlmAgent(
    name="orchestrator",
    model=MODEL,
    description="顧客提案ワークフロー全体を統括するコーディネーター。",
    instruction="""あなたは顧客提案ワークフローのコーディネーターです。
ユーザーは通常「顧客ID C001 の提案を作って」のように依頼します。次の手順で進めてください。

1. 顧客が特定できないときは list_customers で一覧を提示し、対象を確認する。
2. analyst ツールを呼び、その顧客の分析結果を得る。（これは Toolエージェント = agent-as-tool）
3. proposal_writer に処理を委譲(transfer)し、提案(title / body / recommended_product_ids)を
   作成させる。（これは サブエージェント）
4. 作成された提案の下書きは save_draft_to_gcs で一時保存できる（GCS相当）。
   draft_id をユーザーに伝える。
5. ユーザーが明示的に「承認」と言ったときにのみ write_proposal_to_bq でBQに書き戻す。
   承認前に勝手に書き戻さないこと。

常に日本語で、判断の根拠（どのデータに基づくか）を添えて説明してください。
""",
    tools=[
        list_customers,
        AgentTool(agent=analyst_agent),  # ← Toolエージェント
        save_draft_to_gcs,
        load_draft_from_gcs,
        write_proposal_to_bq,
    ],
    sub_agents=[proposal_writer_agent],  # ← サブエージェント
)
