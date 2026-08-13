"""UIで扱いやすいように、提案を構造化JSONで受け取るためのスキーマ。

ADK の LlmAgent に output_schema として渡すと、モデルがこの形の
JSON を返すよう制御されます（＝UI側でパース不要で使える）。
"""
from pydantic import BaseModel, Field


class ProposalOut(BaseModel):
    """提案の構造化出力。"""

    title: str = Field(description="提案のタイトル（1行、訴求力のあるもの）")
    body: str = Field(description="提案本文（3〜5文。顧客の現状に触れ、具体的な価値と根拠を示す）")
    recommended_product_ids: list[str] = Field(
        description='推奨する商品IDのリスト（例: ["P300", "P500"]）'
    )
