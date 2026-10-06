"""Cloud SQL の自動起動・自動停止。

- 普段、DB は停止している(課金は、ストレージ分だけ)。
- 画面からデータの依頼が来たとき、停止中なら起動を依頼し、「準備中(db_starting)」と返す(画面は、準備ができるまで待つ)。
- 最後のアクセスの時刻を、GCS に残す。Cloud Scheduler が定期的に /internal/idle-check を呼び、
  一定時間(既定 30 分)アクセスがなければ、停止を依頼する。Cloud Run は 0 台に縮むので、時刻はメモリに持てない。

起動と停止は、Cloud SQL の「稼働ポリシー」(ALWAYS / NEVER)を切り替えて行う。起動には、通常 1〜3 分かかる。
有効にするのは、環境変数 DB_CONTROL=1 と CLOUD_SQL_INSTANCE(<プロジェクト>:<リージョン>:<インスタンス>)があるときだけ。
手元の開発や、別の PostgreSQL(DATABASE_URL)を使うときは、何もしない。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any
from urllib.parse import quote

from .creds import get_credentials

log = logging.getLogger("ccp.dbctl")

SQL_API = "https://sqladmin.googleapis.com/sql/v1beta4"
GCS_API = "https://storage.googleapis.com"
ACTIVITY_OBJECT = "state/last_activity.json"
TOUCH_INTERVAL_S = 60  # 最後のアクセスの時刻の書き込みは、1 分に 1 回まで
STATUS_CACHE_S = 4


def enabled() -> bool:
    return os.getenv("DB_CONTROL") == "1" and bool(os.getenv("CLOUD_SQL_INSTANCE")) and not os.getenv("DATABASE_URL")


class DbNotReady(RuntimeError):
    """DB が使えない(起動中など)。画面には、準備中として返す"""

    def __init__(self, state: str) -> None:
        super().__init__(state)
        self.state = state


def classify(instance: dict[str, Any]) -> str:
    """Cloud SQL の応答から、running / starting / stopping / stopped / unknown を決める"""
    state = instance.get("state", "")
    policy = (instance.get("settings") or {}).get("activationPolicy", "")
    if policy == "ALWAYS":
        return "running" if state == "RUNNABLE" else "starting"
    if policy == "NEVER":
        # 停止中でも、API の state は RUNNABLE のまま(停止かどうかは、稼働ポリシーで決まる)。切り替えの途中だけ、別の state になる
        return "stopped" if state in ("RUNNABLE", "STOPPED", "SUSPENDED") else "stopping"
    return "unknown"


class DbController:
    def __init__(self) -> None:
        self.project, self.region, self.name = os.environ["CLOUD_SQL_INSTANCE"].split(":")
        self.bucket = os.getenv("STATE_BUCKET", "")
        self._session: Any = None
        self._cached: tuple[float, str] = (0.0, "unknown")
        self._last_touch = 0.0

    # ---- Google Cloud の呼び出し(同期。asyncio.to_thread で呼ぶ。テストでは、差し替える)
    def _http(self) -> Any:
        if self._session is None:
            from google.auth.transport.requests import AuthorizedSession

            self._session = AuthorizedSession(get_credentials())
        return self._session

    def _get_instance(self) -> dict[str, Any]:
        r = self._http().get(f"{SQL_API}/projects/{self.project}/instances/{self.name}", timeout=20)
        r.raise_for_status()
        return r.json()

    def _set_policy(self, policy: str) -> None:
        r = self._http().patch(f"{SQL_API}/projects/{self.project}/instances/{self.name}", json={"settings": {"activationPolicy": policy}}, timeout=30)
        r.raise_for_status()

    def _read_activity(self) -> float | None:
        r = self._http().get(f"{GCS_API}/storage/v1/b/{self.bucket}/o/{quote(ACTIVITY_OBJECT, safe='')}?alt=media", timeout=15)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return float(json.loads(r.text)["ts"])

    def _write_activity(self, ts: float) -> None:
        r = self._http().post(
            f"{GCS_API}/upload/storage/v1/b/{self.bucket}/o?uploadType=media&name={quote(ACTIVITY_OBJECT, safe='')}",
            data=json.dumps({"ts": ts}),
            headers={"Content-Type": "application/json"},
            timeout=15,
        )
        r.raise_for_status()

    # ---- 状態
    async def status(self, fresh: bool = False) -> str:
        at, value = self._cached
        if not fresh and time.monotonic() - at < STATUS_CACHE_S:
            return value
        value = classify(await asyncio.to_thread(self._get_instance))
        self._cached = (time.monotonic(), value)
        return value

    async def ensure_running(self) -> None:
        """使える状態ならそのまま戻る。停止中なら起動を依頼して、DbNotReady を投げる"""
        state = await self.status()
        if state == "running":
            return
        if state == "stopped":
            log.info("DB を起動します")
            await asyncio.to_thread(self._set_policy, "ALWAYS")
            self._cached = (time.monotonic(), "starting")
        raise DbNotReady("starting" if state in ("stopped", "starting", "stopping") else state)

    async def touch(self) -> None:
        """最後のアクセスの時刻を、GCS に残す(1 分に 1 回まで)"""
        now = time.time()
        if not self.bucket or now - self._last_touch < TOUCH_INTERVAL_S:
            return
        self._last_touch = now
        try:
            await asyncio.to_thread(self._write_activity, now)
        except Exception:  # noqa: BLE001 — 時刻が書けなくても、アクセスは止めない(停止が、遅れるだけ)
            log.exception("最後のアクセスの時刻を書けませんでした")

    async def idle_check(self, idle_minutes: float) -> dict[str, Any]:
        """アクセスがなくなってから idle_minutes を過ぎていたら、DB の停止を依頼する"""
        state = await self.status(fresh=True)
        if state != "running":
            return {"action": "none", "state": state}
        last = await asyncio.to_thread(self._read_activity) if self.bucket else None
        now = time.time()
        if last is None:
            # 時刻が残っていない(手動で起動した直後など)。今を起点にして、猶予を与える
            await asyncio.to_thread(self._write_activity, now)
            return {"action": "none", "state": state, "note": "起点を記録しました"}
        idle = (now - last) / 60
        if idle < idle_minutes:
            return {"action": "none", "state": state, "idleMinutes": round(idle, 1)}
        log.info("%.1f 分アクセスがないので、DB を停止します", idle)
        await asyncio.to_thread(self._set_policy, "NEVER")
        self._cached = (time.monotonic(), "stopping")
        return {"action": "stop", "state": "stopping", "idleMinutes": round(idle, 1)}


_controller: DbController | None = None


def controller() -> DbController:
    global _controller
    if _controller is None:
        _controller = DbController()
    return _controller
