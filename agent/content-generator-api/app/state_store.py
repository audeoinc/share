"""JSON ファイルによる状態の保存・読み出し（DB を使わない永続化）。

第一歩のサンプルなので、扱う状態は「カウンタ」だけ。ただし、この先で作る
「ジョブの開始 / 中断 / 再開」も、保存するデータの形が変わるだけで仕組みは同じ。

設計メモ:
- 保存先は環境変数 CONTENT_API_STATE_FILE で差し替えられる。
  こうしておくとテストのたびに一時ディレクトリへ書けるので、実データを汚さない。
- 書き込みは「一時ファイル → os.replace」で行う。途中で落ちても JSON が
  半端な状態で残らない（アトミックに置き換わる）。
- 1 プロセス内の同時アクセス対策として Lock を持つ。
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_DEFAULT_STATE_FILE = Path(__file__).resolve().parent.parent / "data" / "state.json"

# 状態の初期値。ファイルが無いときはこれが使われる。
_INITIAL_STATE: dict[str, Any] = {"counter": 0}

_lock = threading.Lock()


def state_file() -> Path:
    """状態ファイルのパス。環境変数があればそちらを優先する。"""
    override = os.getenv("CONTENT_API_STATE_FILE")
    return Path(override) if override else _DEFAULT_STATE_FILE


def load_state() -> dict[str, Any]:
    """状態を読み込む。ファイルが無ければ初期状態を返す。"""
    path = state_file()
    if not path.exists():
        return dict(_INITIAL_STATE)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_state(state: dict[str, Any]) -> None:
    """状態を保存する（一時ファイルへ書いてから置き換える）。"""
    path = state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def increment_counter(step: int = 1) -> dict[str, Any]:
    """カウンタを増やして、更新後の状態を返す。"""
    with _lock:
        state = load_state()
        state["counter"] = int(state.get("counter", 0)) + step
        save_state(state)
        return state


def reset_state() -> dict[str, Any]:
    """状態を初期値へ戻す。"""
    with _lock:
        state = dict(_INITIAL_STATE)
        save_state(state)
        return state
