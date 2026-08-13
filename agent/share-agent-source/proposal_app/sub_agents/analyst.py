"""Analyst エージェント。

このエージェントは root から「agent-as-tool（Toolエージェント）」として
呼び出されます。＝ root の LlmAgent が AgentTool 経由で道具のように呼び、
結果を受け取って処理を続けます（制御は自動で root に戻る）。
"""
from google.adk.agents import LlmAgent

from ..config import MODEL
from ..tools import get_customer_detail, get_purchase_history, list_products

analyst_agent = LlmAgent(
    name="analyst",
    model=MODEL,
    description=(
        "指定された顧客のBQデータ（属性・購買履歴）と商品カタログを分析し、"
        "ニーズ・課題・提案機会を根拠付きで要約する分析専門エージェント。"
    ),
    instruction="""あなたは優秀なB2Bデータアナリストです。
与えられた顧客ID(customer_id)について、次の手順で分析してください。

1. get_customer_detail で顧客属性（セグメント/業種/LTV/解約リスク/最近の動き）を取得する。
2. get_purchase_history で購買履歴を取得する。
3. list_products で提案候補になりうる商品カタログを把握する。

その上で、以下を **データを根拠として** 簡潔な日本語で要約してください:
- 顧客の現状と特徴
- 解約リスク要因 / 継続要因
- アップセル・クロスセルの機会（どの商品が有望か、その理由）

注意:
- ここでは「分析」に徹し、顧客向けの提案文そのものは書かないこと。
- 推測は「推測」と明示し、データに基づく事実と区別すること。
""",
    tools=[get_customer_detail, get_purchase_history, list_products],
)
