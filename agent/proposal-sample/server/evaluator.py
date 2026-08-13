"""提案品質の審査（LLM-as-judge）。

ADK の LlmAgent + 構造化出力（output_schema）を審査員に使い、提案を採点する。
- Web の `/api/evaluate`（server/main.py）から呼ばれる
- CLI の `eval/run_eval.py` からも共有される
"""
from __future__ import annotations

import json

from pydantic import BaseModel, Field
from google.adk.agents import LlmAgent
from google.adk.runners import InMemoryRunner
from google.genai import types

from proposal_app.config import MODEL

APP_NAME = "eval_judge"
USER_ID = "eval"


class Judgement(BaseModel):
    grounding: int = Field(description="分析（データの根拠）に沿っているか（1=全く〜5=完全に）")
    relevance: int = Field(description="顧客の状況・課題（解約リスク/利用状況など）に即しているか（1〜5）")
    actionability: int = Field(description="具体的で、営業がそのまま使えるレベルか（1〜5）")
    reason: str = Field(description="採点理由（1〜2文、日本語）")


judge_agent = LlmAgent(
    name="judge",
    model=MODEL,
    description="営業提案の品質を採点する審査員。",
    instruction="""あなたは営業提案の品質を評価する厳しめの審査員です。
与えられた「顧客情報」「分析」「提案」を読み、次の3観点を各1〜5で採点してください。
- grounding: 提案が分析（データの根拠）に沿っているか
- relevance: 顧客の状況・課題（解約リスク/利用状況など）に即しているか
- actionability: 具体的で、営業がそのまま使えるレベルか
甘くつけず、根拠が弱ければ低くつけること。理由も簡潔に日本語で述べる。
""",
    output_schema=Judgement,
    output_key="judgement",
)

_judge_runner = InMemoryRunner(agent=judge_agent, app_name=APP_NAME)


async def evaluate(customer: dict, analysis: str, proposal: dict) -> dict:
    """提案を採点して {grounding, relevance, actionability, reason, avg} を返す。"""
    session = await _judge_runner.session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID
    )
    text = (
        f"# 顧客情報\n{json.dumps(customer, ensure_ascii=False)}\n\n"
        f"# 分析\n{analysis}\n\n"
        f"# 提案\n{json.dumps(proposal, ensure_ascii=False)}"
    )
    message = types.Content(role="user", parts=[types.Part(text=text)])
    async for _ in _judge_runner.run_async(
        user_id=USER_ID, session_id=session.id, new_message=message
    ):
        pass
    final = await _judge_runner.session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session.id
    )
    j = final.state.get("judgement", {})
    if isinstance(j, str):
        try:
            j = json.loads(j)
        except json.JSONDecodeError:
            j = {}
    scores = [j.get("grounding", 0), j.get("relevance", 0), j.get("actionability", 0)]
    try:
        avg = round(sum(int(s) for s in scores) / 3, 1)
    except (TypeError, ValueError):
        avg = 0.0
    return {
        "grounding": j.get("grounding"),
        "relevance": j.get("relevance"),
        "actionability": j.get("actionability"),
        "reason": j.get("reason", ""),
        "avg": avg,
    }
