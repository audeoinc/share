"""データ層（BQ/GCS の疑似）。

これまで json-server(:3000) で外出ししていたデータを、FastAPI と同一プロセス内で
保持するインメモリ・ストアに置き換えたもの。Cloud Run のように「1コンテナ・1ポート」
の環境で動かしやすくするための構成。

- 起動時に mock/db.json を種(seed)として読み込む
- customers / products / purchases は参照のみ
- drafts / proposals は作成・更新できる（id は自動採番）

注意（学習メモ）:
- 保存はインメモリのため、プロセス再起動やインスタンスのスケールで消える。
  永続化したい場合は、この関数群の中身を GCS や Firestore、BigQuery に差し替える
  （呼び出し側=tools.py は変更不要）。
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

_DB_PATH = Path(__file__).resolve().parent.parent / "mock" / "db.json"
_lock = threading.Lock()
_data: dict | None = None


def _ensure() -> None:
    global _data
    if _data is None:
        with open(_DB_PATH, encoding="utf-8") as f:
            _data = json.load(f)
        for key in ("customers", "products", "purchases", "drafts", "proposals", "versions"):
            _data.setdefault(key, [])


def _next_id(items: list[dict]) -> int:
    ids = [i.get("id") for i in items if isinstance(i.get("id"), int)]
    return (max(ids) + 1) if ids else 1


# ---- 参照 -------------------------------------------------------------------

def list_customers() -> list[dict]:
    _ensure()
    return list(_data["customers"])


def get_customer(customer_id: str) -> dict | None:
    _ensure()
    return next((c for c in _data["customers"] if str(c.get("id")) == str(customer_id)), None)


def list_products() -> list[dict]:
    _ensure()
    return list(_data["products"])


def get_purchases(customer_id: str) -> list[dict]:
    _ensure()
    return [p for p in _data["purchases"] if str(p.get("customer_id")) == str(customer_id)]


def list_proposals(customer_id: str | None = None) -> list[dict]:
    _ensure()
    items = _data["proposals"]
    if customer_id:
        items = [p for p in items if str(p.get("customer_id")) == str(customer_id)]
    return list(items)


# ---- 作成・更新 -------------------------------------------------------------

def create_draft(rec: dict) -> dict:
    _ensure()
    with _lock:
        rec = dict(rec)
        rec["id"] = _next_id(_data["drafts"])
        _data["drafts"].append(rec)
        return rec


def get_draft(draft_id: str) -> dict | None:
    _ensure()
    return next((d for d in _data["drafts"] if str(d.get("id")) == str(draft_id)), None)


def create_proposal(rec: dict) -> dict:
    _ensure()
    with _lock:
        rec = dict(rec)
        rec["id"] = _next_id(_data["proposals"])
        _data["proposals"].append(rec)
        return rec


def update_proposal(proposal_id: str, rec: dict) -> dict | None:
    _ensure()
    with _lock:
        for i, p in enumerate(_data["proposals"]):
            if str(p.get("id")) == str(proposal_id):
                merged = dict(rec)
                merged["id"] = p.get("id")
                _data["proposals"][i] = merged
                return merged
        return None


def delete_proposal(proposal_id: str) -> bool:
    _ensure()
    with _lock:
        before = len(_data["proposals"])
        _data["proposals"] = [p for p in _data["proposals"] if str(p.get("id")) != str(proposal_id)]
        return len(_data["proposals"]) < before


# ---- 版管理（生成/再提案の作業履歴） ---------------------------------------

def list_versions(customer_id: str | None = None) -> list[dict]:
    _ensure()
    items = _data["versions"]
    if customer_id:
        items = [v for v in items if str(v.get("customer_id")) == str(customer_id)]
    return list(items)


def create_version(rec: dict) -> dict:
    _ensure()
    with _lock:
        rec = dict(rec)
        rec["id"] = _next_id(_data["versions"])
        _data["versions"].append(rec)
        return rec


def delete_version(version_id: str) -> bool:
    _ensure()
    with _lock:
        before = len(_data["versions"])
        _data["versions"] = [v for v in _data["versions"] if str(v.get("id")) != str(version_id)]
        return len(_data["versions"]) < before
