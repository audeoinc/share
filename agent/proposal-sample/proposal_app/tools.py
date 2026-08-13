"""エージェントが使う Tool 群。

本番では BigQuery / GCS の SDK を呼ぶところを、学習用に同一プロセス内の
インメモリ・ストア(store.py)で疑似再現しています。データ層を差し替えたい場合は
store.py の中身だけを変えればよく、この Tool 群の呼び出し側は無改修で済みます。

ADK では、型ヒントと docstring 付きの通常の Python 関数をそのまま Tool として
渡せます（FunctionTool に自動ラップされます）。docstring は「LLM がその Tool を
いつ・どう使うか」を判断する材料になるため、用途・引数・戻り値を明確に書きます。
"""
from __future__ import annotations

from . import store


# ---- BQ 読み取り相当 ---------------------------------------------------------

def list_customers() -> list[dict]:
    """全顧客の一覧を取得する（BQの customers テーブル相当）。

    Returns:
        顧客レコードのリスト。各要素は id, name, segment, industry,
        ltv, churn_risk, recent_activity などを含む。
    """
    return store.list_customers()


def get_customer_detail(customer_id: str) -> dict:
    """指定した顧客IDの詳細を取得する（BQの customers テーブル相当）。

    Args:
        customer_id: 顧客ID（例: "C001"）。

    Returns:
        顧客1件の詳細レコード。存在しない場合は {"error": ...}。
    """
    c = store.get_customer(customer_id)
    return c if c else {"error": f"customer_id={customer_id} が見つかりません"}


def get_purchase_history(customer_id: str) -> list[dict]:
    """指定した顧客の購買履歴を取得する（BQの purchases テーブル相当）。

    Args:
        customer_id: 顧客ID（例: "C001"）。

    Returns:
        購買レコードのリスト。各要素は product_id, date, amount を含む。
    """
    return store.get_purchases(customer_id)


def list_products() -> list[dict]:
    """提案候補になりうる商品カタログを取得する（BQの products テーブル相当）。

    Returns:
        商品レコードのリスト。各要素は id, name, category, price,
        target_segment, description を含む。
    """
    return store.list_products()


# ---- GCS 一時保存相当（下書き） ---------------------------------------------

def save_draft_to_gcs(
    customer_id: str,
    title: str,
    body: str,
    recommended_product_ids: list[str],
) -> dict:
    """提案の下書きを一時保存する（GCSにJSONを置く相当）。

    承認前の作業中データの退避に使う。戻り値の draft_id を控えておくと
    後から load_draft_from_gcs で読み戻せる。

    Args:
        customer_id: 対象顧客ID。
        title: 提案タイトル。
        body: 提案本文。
        recommended_product_ids: 推奨商品IDのリスト。

    Returns:
        保存された下書き（自動採番された id を含む）。
    """
    saved = store.create_draft({
        "customer_id": customer_id,
        "title": title,
        "body": body,
        "recommended_product_ids": recommended_product_ids,
        "status": "draft",
    })
    return {"draft_id": saved.get("id"), "saved": saved}


def load_draft_from_gcs(draft_id: str) -> dict:
    """一時保存した下書きを読み出す（GCSのJSONを読む相当）。

    Args:
        draft_id: save_draft_to_gcs が返した下書きID。

    Returns:
        下書きレコード。存在しない場合は {"error": ...}。
    """
    d = store.get_draft(draft_id)
    return d if d else {"error": f"draft_id={draft_id} が見つかりません"}


# ---- BQ 書き戻し相当 ---------------------------------------------------------

def write_proposal_to_bq(
    customer_id: str,
    title: str,
    body: str,
    recommended_product_ids: list[str],
) -> dict:
    """承認済みの提案をBQに書き戻す（proposals テーブルへの INSERT 相当）。

    重要: ユーザーが明示的に「承認」した後にのみ呼ぶこと。

    Args:
        customer_id: 対象顧客ID。
        title: 提案タイトル。
        body: 提案本文。
        recommended_product_ids: 推奨商品IDのリスト。

    Returns:
        書き込まれた提案レコード（自動採番された id を含む）。
    """
    saved = store.create_proposal({
        "customer_id": customer_id,
        "title": title,
        "body": body,
        "recommended_product_ids": recommended_product_ids,
        "status": "approved",
    })
    return {"proposal_id": saved.get("id"), "saved": saved}


def update_proposal_in_bq(
    proposal_id: str,
    customer_id: str,
    title: str,
    body: str,
    recommended_product_ids: list[str],
) -> dict:
    """既存の提案を上書き更新する（proposals テーブルの UPDATE 相当）。

    Args:
        proposal_id: 更新対象の提案ID。
        customer_id: 対象顧客ID。
        title: 提案タイトル。
        body: 提案本文。
        recommended_product_ids: 推奨商品IDのリスト。

    Returns:
        更新後の提案レコード。存在しなければ {"error": ...}。
    """
    saved = store.update_proposal(proposal_id, {
        "customer_id": customer_id,
        "title": title,
        "body": body,
        "recommended_product_ids": recommended_product_ids,
        "status": "approved",
    })
    if not saved:
        return {"error": f"proposal_id={proposal_id} が見つかりません"}
    return {"proposal_id": saved.get("id"), "saved": saved}
