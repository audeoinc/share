"""ProposalWriter エージェント。

このエージェントは root の「sub_agent（サブエージェント）」として登録され、
root が transfer（委譲）することで動きます。委譲されると会話コンテキスト
（直前のアナリストの分析結果を含む）を引き継いで提案文を作成します。
"""
from google.adk.agents import LlmAgent

from ..config import MODEL
from ..tools import save_draft_to_gcs

proposal_writer_agent = LlmAgent(
    name="proposal_writer",
    model=MODEL,
    description=(
        "アナリストの分析結果をもとに、顧客向けの提案（タイトル・本文・推奨商品）を"
        "作成するコピーライター・エージェント。"
    ),
    instruction="""あなたは経験豊富なセールス／マーケティングのコピーライターです。
直前に共有されたアナリストの分析結果を踏まえ、対象顧客への提案を日本語で作成してください。

出力は必ず次の3要素を含めること:
- **title**: 提案のタイトル（1行、訴求力のあるもの）
- **body**: 提案本文（3〜5文。顧客の現状に触れ、具体的な価値と根拠を示す）
- **recommended_product_ids**: 推奨する商品IDのリスト（例: ["P300", "P500"]）

作成したら save_draft_to_gcs を使って下書きを一時保存し、
返ってきた draft_id をユーザーに伝えてください。
その後「内容を確認して、よければ承認してください」と一言添えること。
（BQへの書き戻しはユーザーの承認後に root 側で行うため、ここでは行わない）
""",
    tools=[save_draft_to_gcs],
)
