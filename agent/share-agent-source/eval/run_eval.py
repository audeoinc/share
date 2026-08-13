"""提案品質の自動評価ハーネス（ADK を使った Eval）。

生成される提案は毎回文面が変わる創作物なので、厳密な文字列一致ではなく
次の2軸で評価する:

1. ルールベースの品質ゲート（決定論・高速・無料）
   - title/body が空でない、推奨商品IDが妥当、期待カテゴリの商品を含む 等
2. LLM-as-judge（ADK の LlmAgent + 構造化出力を審査員に使う）
   - grounding（分析の根拠に沿うか） / relevance（顧客状況に即すか） / actionability（具体的か）を各1〜5で採点

実行:
    ./.venv/Scripts/python.exe eval/run_eval.py
全ケース合格なら終了コード0（CIにも載せられる）。※ 実行時に Gemini 課金が発生します。
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

# Windows の cp932 端末でも日本語/記号で落ちないよう UTF-8 出力にする
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from dotenv import load_dotenv  # noqa: E402

load_dotenv(_ROOT / "proposal_app" / ".env")

from pydantic import BaseModel, Field  # noqa: E402
from google.adk.agents import LlmAgent  # noqa: E402
from google.adk.runners import InMemoryRunner  # noqa: E402
from google.genai import types  # noqa: E402

from proposal_app import store  # noqa: E402
from proposal_app.config import MODEL  # noqa: E402
from server.pipeline import generate_proposal  # noqa: E402

# ---- 合格しきい値 -----------------------------------------------------------
JUDGE_PASS_AVG = 3.5  # LLM-as-judge の平均スコア（1〜5）がこれ以上で合格
MIN_BODY_LEN = 40


# ---- LLM-as-judge（ADK の LlmAgent を審査員に使う） -------------------------

class Judgement(BaseModel):
    grounding: int = Field(description="分析の根拠に沿っているか（1=全く〜5=完全に）")
    relevance: int = Field(description="顧客の状況・課題に即しているか（1〜5）")
    actionability: int = Field(description="具体的で実行可能か（1〜5）")
    reason: str = Field(description="採点理由（1〜2文）")


judge_agent = LlmAgent(
    name="judge",
    model=MODEL,
    description="営業提案の品質を採点する審査員。",
    instruction="""あなたは営業提案の品質を評価する厳しめの審査員です。
与えられた「顧客情報」「分析」「提案」を読み、次の3観点を各1〜5で採点してください。
- grounding: 提案が分析（データの根拠）に沿っているか
- relevance: 顧客の状況・課題（解約リスク/利用状況など）に即しているか
- actionability: 具体的で、営業がそのまま使えるレベルか
甘くつけず、根拠が弱ければ低くつけること。理由も簡潔に述べる。
""",
    output_schema=Judgement,
    output_key="judgement",
)
_judge_runner = InMemoryRunner(agent=judge_agent, app_name="eval_judge")


async def judge(customer: dict, analysis: str, proposal: dict) -> dict:
    session = await _judge_runner.session_service.create_session(
        app_name="eval_judge", user_id="eval"
    )
    text = (
        f"# 顧客情報\n{json.dumps(customer, ensure_ascii=False)}\n\n"
        f"# 分析\n{analysis}\n\n"
        f"# 提案\n{json.dumps(proposal, ensure_ascii=False)}"
    )
    message = types.Content(role="user", parts=[types.Part(text=text)])
    async for _ in _judge_runner.run_async(
        user_id="eval", session_id=session.id, new_message=message
    ):
        pass
    final = await _judge_runner.session_service.get_session(
        app_name="eval_judge", user_id="eval", session_id=session.id
    )
    j = final.state.get("judgement", {})
    if isinstance(j, str):
        try:
            j = json.loads(j)
        except json.JSONDecodeError:
            j = {}
    return j


# ---- テストケース（ダミーデータの状況に基づく期待） ------------------------
# must_products_any: 少なくとも1つは含んでほしい商品ID（＝提案の妥当性の最低ライン）
CASES = [
    {"customer_id": "C002", "must_products_any": ["P700", "P800", "P500", "P300"],
     "note": "解約リスク高・休眠 → 活用促進/維持系を期待"},
    {"customer_id": "C005", "must_products_any": ["P300"],
     "note": "ストレージ上限に頻繁到達 → 容量追加(P300)を期待"},
    {"customer_id": "C001", "must_products_any": ["P300", "P500", "P800"],
     "note": "上限接近・問い合わせ増 → 容量/サポート/分析を期待"},
]


def rule_checks(proposal: dict, must_any: list[str]) -> list[str]:
    issues = []
    if not proposal.get("title"):
        issues.append("titleが空")
    if len(proposal.get("body", "")) < MIN_BODY_LEN:
        issues.append(f"bodyが短い(<{MIN_BODY_LEN})")
    ids = proposal.get("recommended_product_ids", []) or []
    if not ids:
        issues.append("推奨商品が空")
    valid = {p["id"] for p in store.list_products()}
    if any(i not in valid for i in ids):
        issues.append("不正な商品IDを含む")
    if must_any and not (set(ids) & set(must_any)):
        issues.append(f"期待商品{must_any}のいずれも含まない")
    return issues


async def main() -> int:
    print("=" * 64)
    print(" 提案品質 自動評価 (ADK: ルールベース + LLM-as-judge)")
    print("=" * 64)
    all_pass = True
    for case in CASES:
        cid = case["customer_id"]
        customer = store.get_customer(cid)
        out = await generate_proposal(cid)
        proposal = out.get("proposal", {})
        analysis = out.get("analysis", "")

        issues = rule_checks(proposal, case["must_products_any"])
        j = await judge(customer, analysis, proposal)
        scores = [j.get("grounding", 0), j.get("relevance", 0), j.get("actionability", 0)]
        try:
            avg = sum(int(s) for s in scores) / 3
        except (TypeError, ValueError):
            avg = 0.0
        passed = (not issues) and avg >= JUDGE_PASS_AVG
        all_pass = all_pass and passed

        print(f"\n■ {cid}（{case['note']}）  … {'PASS' if passed else 'FAIL'}")
        print(f"  提案: {proposal.get('title', '')[:40]}")
        print(f"  推奨商品: {proposal.get('recommended_product_ids', [])}")
        print(f"  judge: grounding={j.get('grounding')} relevance={j.get('relevance')} "
              f"actionability={j.get('actionability')} (avg={avg:.1f}/5)")
        print(f"  理由: {j.get('reason', '')[:80]}")
        if issues:
            print(f"  ルール違反: {issues}")

    print("\n" + "=" * 64)
    print(f" 総合: {'[ALL PASS]' if all_pass else '[FAIL]'}")
    print("=" * 64)
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
