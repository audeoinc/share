"""ダッシュボード用の決定論的パイプライン。

`adk web` 用の会話型 orchestrator とは別に、UIから使いやすいように
「分析 → 構造化された提案JSON」を生成する。

- 初回生成: analyst → proposal_writer（SequentialAgent）
- 再提案  : 既存の分析＋前回提案＋ユーザー指示を渡し、proposal だけを再実行
            （分析は同じなので再計算しない＝速い・安い）

提案は output_schema(ProposalOut) で構造化JSONとして受け取る。
"""
from __future__ import annotations

import json

from google.adk.agents import LlmAgent, SequentialAgent
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import InMemoryRunner
from google.genai import types

from proposal_app.config import MODEL
from proposal_app.schemas import ProposalOut
from proposal_app.tools import (
    get_customer_detail,
    get_purchase_history,
    list_products,
)

APP_NAME = "proposal_web"
USER_ID = "dashboard"


def _build_analyst(name: str = "analyst_web") -> LlmAgent:
    return LlmAgent(
        name=name,
        model=MODEL,
        description="顧客データを分析して要約する（Web用）。",
        instruction="""【最重要・言語ルール】
あなたの思考（reasoning / thinking / 内部推論）も、最終的な回答も、**すべて日本語だけ**で
書いてください。英語やその他の言語で考えたり書いたりすることは禁止です。頭の中の下書き・
検討・ステップの列挙・自問自答も、必ず日本語の文で行ってください。

あなたは優秀なB2Bデータアナリストです。
与えられた顧客ID(customer_id)について:
1. get_customer_detail で顧客属性を取得
2. get_purchase_history で購買履歴を取得
3. list_products で提案候補の商品カタログを把握
これらのデータを根拠に、顧客の現状・解約リスク・アップセル/クロスセル機会を
簡潔な日本語で要約してください。提案文そのものは書かないこと。
""",
        tools=[get_customer_detail, get_purchase_history, list_products],
        output_key="analysis",
        # Gemini の思考(thinking)を有効化。思考パートは part.thought=True で分離できる。
        # thinking_level="high" でより深く推論させる（その分やや遅くなる）。
        generate_content_config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(
                include_thoughts=True, thinking_level="high"
            )
        ),
    )


def _build_proposal_writer(name: str = "proposal_writer_web") -> LlmAgent:
    # ツールなし・構造化出力。分析はコンテキスト（初回は直前の会話、再提案はメッセージ本文）から受け取る。
    return LlmAgent(
        name=name,
        model=MODEL,
        description="分析結果から提案を構造化JSONで作る（Web用）。",
        instruction="""【最重要・言語ルール】
あなたの思考（reasoning / thinking / 内部推論）も、最終的な回答も、**すべて日本語だけ**で
書いてください。英語やその他の言語で考えたり書いたりすることは禁止です。どの分析根拠を
採用するか、なぜその商品を推すか等の検討・自問自答も、必ず日本語の文で行ってください。

あなたは経験豊富なセールス／マーケティングのコピーライターです。
提供された分析結果を踏まえ、対象顧客への提案を作成してください。
ユーザーからの追加指示がある場合は、それを最優先で反映すること。
title / body / recommended_product_ids を持つJSONで出力すること。
recommended_product_ids は分析で有望とされた商品IDを入れる。
なお最終的な出力は指定どおり title / body / recommended_product_ids のJSONのみとし、
思考の文章を JSON 本文に混ぜないこと。
""",
        output_schema=ProposalOut,
        output_key="proposal",
        # 提案フェーズの思考も表示するため thinking を有効化。
        # output_schema(JSON)とは別に part.thought=True の思考パートとして流れる。
        generate_content_config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(
                include_thoughts=True, thinking_level="high"
            )
        ),
    )


def emit_proposal(
    title: str, body: str, recommended_product_ids: list[str]
) -> dict:
    """提案が固まったら呼び出して内容を確定する（チャット用の確定ツール）。

    まだ要件が曖昧・相談中の段階では呼ばず、日本語のテキストで応答すること。
    予算・トーン・訴求ポイント・対象商品など、提案に必要な条件が揃ったと判断した
    ときにだけ、このツールで最終的な提案を確定する。

    Args:
        title: 提案タイトル（1行、訴求力のあるもの）。
        body: 提案本文（3〜5文。顧客の現状に触れ、具体的な価値と根拠を示す）。
        recommended_product_ids: 推奨する商品IDのリスト（例: ["P300", "P500"]）。

    Returns:
        確定した提案（そのままエコーして返す）。
    """
    return {
        "title": title,
        "body": body,
        "recommended_product_ids": recommended_product_ids,
    }


def _build_chat_agent(name: str = "proposal_chat") -> LlmAgent:
    """対話型の提案エージェント（往復のやりとりができる）。

    ポイント: output_schema を付けない。JSON固定出力に縛らないことで、
    情報が足りないときは自然文で「質問を返す」ことができる。要件が揃ったら
    emit_proposal ツールを呼んで構造化された提案を確定する。
    """
    return LlmAgent(
        name=name,
        model=MODEL,
        description="顧客提案を対話しながら固めるセールスコンサルタント（Web用）。",
        instruction="""【最重要・言語ルール】
あなたの思考（reasoning / thinking / 内部推論）も、最終的な回答も、**すべて日本語だけ**で
書いてください。英語やその他の言語で考えたり書いたりすることは禁止です。

あなたは経験豊富なB2Bセールスコンサルタントです。ユーザーと会話しながら、対象顧客への
提案を一緒に固めていきます。次の方針で進めてください。

1. 必要に応じて get_customer_detail / get_purchase_history / list_products で
   対象顧客の状況（属性・購買履歴・提案候補の商品）を把握する。
2. 提案に必要な条件（予算感・トーン・訴求ポイント・対象商品・目的など）が
   **曖昧なときは、確認の質問を1〜2個に絞って返す**。一度にたくさん質問しない。
   このときは emit_proposal を呼ばず、日本語のテキストだけで応答すること。
3. 条件が十分に揃ったと判断したら、emit_proposal を呼んで提案を確定する
   （title / body / recommended_product_ids）。recommended_product_ids には
   実在する商品ID（list_products で得られるID）だけを入れる。
4. emit_proposal を呼んだあとは、確定した旨と要点を1〜2文で簡潔に日本語で伝える。

過去のやりとりは文脈として覚えているので、ユーザーの追加指示を尊重して調整すること。
""",
        tools=[
            get_customer_detail,
            get_purchase_history,
            list_products,
            emit_proposal,
        ],
        # 思考(thinking)を有効化。part.thought=True の思考パートとして流れる。
        generate_content_config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(
                include_thoughts=True, thinking_level="high"
            )
        ),
    )


# 初回生成用: 分析 → 提案 の直列パイプライン
proposal_pipeline = SequentialAgent(
    name="proposal_pipeline",
    description="顧客IDを受け取り、分析してから構造化された提案を生成する。",
    sub_agents=[_build_analyst(), _build_proposal_writer()],
)

# 再提案用: 提案エージェント単体（別インスタンス＝親の重複を避ける）
proposal_refiner = _build_proposal_writer(name="proposal_refiner")

# 対話用: 質問を返せる会話型エージェント（emit_proposal で確定）
proposal_chat = _build_chat_agent()

_pipeline_runner = InMemoryRunner(agent=proposal_pipeline, app_name=APP_NAME)
_refine_runner = InMemoryRunner(agent=proposal_refiner, app_name=APP_NAME)
_chat_runner = InMemoryRunner(agent=proposal_chat, app_name=APP_NAME)


def _parse_proposal(value) -> dict:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return {"title": "", "body": value, "recommended_product_ids": []}
    return value or {}


# 顧客ごとの「会話セッションID」。再提案を同じセッションで続けることで、
# 過去の指示・提案を文脈として覚えたまま改善できる（＝会話の継続）。
#
# 注意（単一ユーザー前提）: このマップはプロセス共有のグローバルで、キーが
# customer_id のみ。同じ顧客を複数ユーザーが同時に操作すると会話が混線し得る
# （インメモリ store も同様にプロセス共有）。本アプリは学習用の「単一ユーザー
# 前提」で割り切っている。多人数対応するなら (user_id, customer_id) をキーにし、
# store も外部（Firestore 等）へ切り出す必要がある。
_conversations: dict[str, str] = {}


async def _run_in_session(
    runner: InMemoryRunner, session_id: str, text: str
) -> tuple[dict, str]:
    """既存セッションでメッセージを1件流し、(最終 state, 思考テキスト) を返す。

    思考(thinking)は part.thought=True のテキストを結合したもの。思考を有効化して
    いないエージェント(例: proposal_writer)では空文字になる。
    """
    message = types.Content(role="user", parts=[types.Part(text=text)])
    thinking_acc = ""
    async for event in runner.run_async(
        user_id=USER_ID, session_id=session_id, new_message=message
    ):
        if getattr(event, "content", None) and event.content.parts:
            for part in event.content.parts:
                if getattr(part, "thought", False) and getattr(part, "text", None):
                    thinking_acc += part.text
    final = await runner.session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    return final.state, thinking_acc


async def _run(runner: InMemoryRunner, text: str) -> tuple[dict, str]:
    """新規セッションで1回だけ実行（単発）。(最終 state, 思考テキスト) を返す。"""
    session = await runner.session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID
    )
    return await _run_in_session(runner, session.id, text)


def reset_conversation(customer_id: str) -> None:
    """その顧客の会話履歴を破棄する（新しい土台で再スタートする時に呼ぶ）。"""
    _conversations.pop(customer_id, None)


async def generate_proposal(customer_id: str) -> dict:
    """顧客IDから、分析テキストと構造化された提案を生成して返す（初回）。"""
    # 新規生成は「新しい土台」なので、それまでの会話はリセットする。
    reset_conversation(customer_id)
    state, thinking = await _run(
        _pipeline_runner, f"顧客ID {customer_id} の提案を作成してください。"
    )
    return {
        "analysis": state.get("analysis", ""),
        "proposal": _parse_proposal(state.get("proposal", {})),
        "thinking": thinking,
    }


async def generate_proposal_stream(customer_id: str):
    """初回生成をストリーミングで行う非同期ジェネレータ。

    生成の進捗を逐次 yield する（各要素は dict）:
      {"type": "status", "text": ...}          … フェーズ通知（データ取得中/提案作成中）
      {"type": "analysis_delta", "text": ...}   … 分析テキストの差分（逐次追記用）
      {"type": "final", "analysis": ..., "proposal": {...}}  … 最終確定値
    """
    reset_conversation(customer_id)
    session = await _pipeline_runner.session_service.create_session(
        app_name=APP_NAME, user_id=USER_ID
    )
    message = types.Content(
        role="user", parts=[types.Part(text=f"顧客ID {customer_id} の提案を作成してください。")]
    )
    cfg = RunConfig(streaming_mode=StreamingMode.SSE)
    proposal_notified = False
    thinking_acc = ""

    async for event in _pipeline_runner.run_async(
        user_id=USER_ID, session_id=session.id, new_message=message, run_config=cfg
    ):
        author = getattr(event, "author", "")

        # ツール呼び出し（顧客データ取得など）を通知
        fcs = event.get_function_calls() if hasattr(event, "get_function_calls") else []
        if fcs:
            yield {"type": "status", "text": "顧客データを取得中…（" + ", ".join(f.name for f in fcs) + "）"}
            continue

        partial = getattr(event, "partial", None)
        if not (getattr(event, "content", None) and event.content.parts):
            continue

        for part in event.content.parts:
            t = getattr(part, "text", None)
            if not t:
                continue
            is_thought = getattr(part, "thought", False)

            # 提案フェーズの「本文(構造化JSON)」は逐次表示しない（最初に一度だけ通知）。
            # 思考(part.thought)は分析・提案の両フェーズとも流す。
            if author == "proposal_writer_web" and not is_thought:
                if not proposal_notified:
                    proposal_notified = True
                    yield {"type": "status", "text": "分析完了。提案を作成中…"}
                continue

            # 差分(partial)だけ流す（累積イベントの二重取込を防ぐ）
            if not partial:
                continue
            if is_thought:
                thinking_acc += t
                yield {"type": "thinking_delta", "text": t}   # Geminiの思考（分析・提案 両方）
            else:
                yield {"type": "analysis_delta", "text": t}   # 分析の本文

    final = await _pipeline_runner.session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session.id
    )
    yield {
        "type": "final",
        "analysis": final.state.get("analysis", ""),
        "proposal": _parse_proposal(final.state.get("proposal", {})),
        "thinking": thinking_acc,
    }


async def _ensure_refine_session(customer_id: str) -> tuple[str, bool]:
    """再提案用セッションを取得（無ければ作成）。(session_id, 初回か) を返す。"""
    is_first_turn = customer_id not in _conversations
    if is_first_turn:
        session = await _refine_runner.session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID
        )
        _conversations[customer_id] = session.id
    return _conversations[customer_id], is_first_turn


def _refine_prompt(customer_id: str, analysis: str, previous_proposal: dict,
                   instruction: str, is_first_turn: bool) -> str:
    """再提案でエージェントに渡すメッセージ本文を組み立てる。"""
    prev = json.dumps(previous_proposal or {}, ensure_ascii=False)
    if is_first_turn:
        return f"""これから顧客ID {customer_id} の提案を、会話しながら改善していきます。

# 分析結果
{analysis}

# 現在の提案(JSON)
{prev}

# 今回の指示（最優先で反映）
{instruction}
"""
    # 2ターン目以降。これまでの会話（過去の指示・提案）は文脈に残っている。
    return f"""これまでの会話を踏まえて、提案をさらに改善してください。

# 現在の提案(JSON)
{prev}

# 今回の指示（最優先で反映）
{instruction}
"""


async def refine_proposal(
    customer_id: str,
    analysis: str,
    previous_proposal: dict,
    instruction: str,
) -> dict:
    """会話を継続しながら、ユーザー指示を反映して提案を作り直す（非ストリーム）。

    顧客ごとに同じセッションを使い回すため、エージェントは**過去の指示も覚えている**。
    現在の提案(previous_proposal)も毎回渡すので、手動修正も尊重される。
    """
    session_id, is_first_turn = await _ensure_refine_session(customer_id)
    text = _refine_prompt(customer_id, analysis, previous_proposal, instruction, is_first_turn)
    state, thinking = await _run_in_session(_refine_runner, session_id, text)
    return {
        "analysis": analysis,  # 分析は据え置き
        "proposal": _parse_proposal(state.get("proposal", {})),
        "thinking": thinking,
    }


async def refine_proposal_stream(
    customer_id: str,
    analysis: str,
    previous_proposal: dict,
    instruction: str,
):
    """再提案をストリーミングで行う非同期ジェネレータ（generate_proposal_stream と同形）。

    yield する要素:
      {"type": "status", "text": ...}         … フェーズ通知
      {"type": "thinking_delta", "text": ...}  … 思考の差分（ライブ表示用）
      {"type": "final", "analysis", "proposal", "thinking"}  … 最終確定値
    """
    session_id, is_first_turn = await _ensure_refine_session(customer_id)
    text = _refine_prompt(customer_id, analysis, previous_proposal, instruction, is_first_turn)
    message = types.Content(role="user", parts=[types.Part(text=text)])
    cfg = RunConfig(streaming_mode=StreamingMode.SSE)

    yield {"type": "status", "text": "指示を反映して再提案中…"}
    thinking_acc = ""
    async for event in _refine_runner.run_async(
        user_id=USER_ID, session_id=session_id, new_message=message, run_config=cfg
    ):
        partial = getattr(event, "partial", None)
        if not (getattr(event, "content", None) and event.content.parts):
            continue
        for part in event.content.parts:
            t = getattr(part, "text", None)
            if not t:
                continue
            # 思考(part.thought)の差分だけライブ配信。本文(構造化JSON)は流さない。
            if getattr(part, "thought", False) and partial:
                thinking_acc += t
                yield {"type": "thinking_delta", "text": t}

    final = await _refine_runner.session_service.get_session(
        app_name=APP_NAME, user_id=USER_ID, session_id=session_id
    )
    yield {
        "type": "final",
        "analysis": analysis,  # 分析は据え置き
        "proposal": _parse_proposal(final.state.get("proposal", {})),
        "thinking": thinking_acc,
    }


# ---- 対話（チャット） -------------------------------------------------------
#
# 生成/再提案が「一方向のフロー」なのに対し、こちらは往復のやりとりができる。
# エージェントは output_schema で縛られていないため、情報が足りなければ質問を返し、
# 要件が揃ったら emit_proposal ツールで提案を確定する。会話は顧客ごとの
# セッションで継続する（過去のやりとりを文脈として覚えている）。

# 顧客ごとの「チャット会話セッションID」。再提案(_conversations)とは別管理。
_chat_sessions: dict[str, str] = {}


def reset_chat(customer_id: str) -> None:
    """その顧客のチャット会話履歴を破棄する（新しい相談を始める時に呼ぶ）。"""
    _chat_sessions.pop(customer_id, None)


async def _ensure_chat_session(customer_id: str) -> tuple[str, bool]:
    """チャット用セッションを取得（無ければ作成）。(session_id, 初回か) を返す。"""
    is_first_turn = customer_id not in _chat_sessions
    if is_first_turn:
        session = await _chat_runner.session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID
        )
        _chat_sessions[customer_id] = session.id
    return _chat_sessions[customer_id], is_first_turn


def _chat_prompt(customer_id: str, message: str, is_first_turn: bool) -> str:
    """チャットでエージェントに渡すメッセージ本文を組み立てる。"""
    if is_first_turn:
        return f"""対象は顧客ID {customer_id} です。必要ならツールで顧客の状況を把握してください。
要件が曖昧なときは確認の質問を返し、十分に揃ったら emit_proposal で提案を確定してください。

# ユーザーからのメッセージ
{message}
"""
    return message


async def chat_stream(customer_id: str, message: str, reset: bool = False):
    """対話（往復）をストリーミングで行う非同期ジェネレータ。

    yield する要素:
      {"type": "status", "text": ...}         … ツール実行などの進捗通知
      {"type": "thinking_delta", "text": ...}  … 思考の差分（ライブ表示用）
      {"type": "reply_delta", "text": ...}     … エージェント返信テキストの差分
      {"type": "final", "reply", "proposal", "thinking"}  … 最終確定値
                                                （proposal は確定時のみ。未確定は None）
    """
    if reset:
        reset_chat(customer_id)
    session_id, is_first_turn = await _ensure_chat_session(customer_id)
    text = _chat_prompt(customer_id, message, is_first_turn)
    msg = types.Content(role="user", parts=[types.Part(text=text)])
    cfg = RunConfig(streaming_mode=StreamingMode.SSE)

    thinking_acc = ""
    reply_acc = ""     # partial の差分を積む（ライブ表示用）
    reply_full = ""    # 非partial（完成テキスト）は最新のものを正とする
    emitted: dict | None = None

    async for event in _chat_runner.run_async(
        user_id=USER_ID, session_id=session_id, new_message=msg, run_config=cfg
    ):
        # ツール呼び出し（データ取得 or 提案確定）を検知
        fcs = event.get_function_calls() if hasattr(event, "get_function_calls") else []
        if fcs:
            for fc in fcs:
                if fc.name == "emit_proposal":
                    emitted = dict(fc.args or {})
                    yield {"type": "status", "text": "提案を確定しています…"}
                else:
                    yield {"type": "status", "text": f"顧客データを取得中…（{fc.name}）"}
            continue

        partial = getattr(event, "partial", None)
        if not (getattr(event, "content", None) and event.content.parts):
            continue
        for part in event.content.parts:
            t = getattr(part, "text", None)
            if not t:
                continue
            if getattr(part, "thought", False):
                if partial:
                    thinking_acc += t
                    yield {"type": "thinking_delta", "text": t}
            else:
                if partial:
                    reply_acc += t
                    yield {"type": "reply_delta", "text": t}
                else:
                    # 完成テキスト（累積）は上書きで正とする
                    reply_full = t

    reply = (reply_full or reply_acc).strip()
    if emitted and not reply:
        reply = "提案を作成しました。右のフォームでご確認ください。"

    proposal = None
    if emitted is not None:
        proposal = {
            "title": emitted.get("title", ""),
            "body": emitted.get("body", ""),
            "recommended_product_ids": list(emitted.get("recommended_product_ids") or []),
        }

    yield {
        "type": "final",
        "reply": reply,
        "proposal": proposal,
        "thinking": thinking_acc,
    }
