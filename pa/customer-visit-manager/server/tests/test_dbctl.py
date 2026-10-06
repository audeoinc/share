"""dbctl.py(DB の自動起動・停止の判断)の単体テスト。Google Cloud には接続しない(呼び出しを、模擬に差し替える)。"""
from __future__ import annotations

import os
import sys
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["CLOUD_SQL_INSTANCE"] = "p:r:i"

from ccp import dbctl  # noqa: E402


def instance(state: str, policy: str) -> dict[str, Any]:
    return {"state": state, "settings": {"activationPolicy": policy}}


class Fake(dbctl.DbController):
    """Google Cloud の代わりに、手元の値を読み書きする"""

    def __init__(self, inst: dict[str, Any], last: float | None = None) -> None:
        super().__init__()
        self.bucket = "b"
        self.inst = inst
        self.last = last
        self.policies: list[str] = []

    def _get_instance(self) -> dict[str, Any]:
        return self.inst

    def _set_policy(self, policy: str) -> None:
        self.policies.append(policy)

    def _read_activity(self) -> float | None:
        return self.last

    def _write_activity(self, ts: float) -> None:
        self.last = ts


class ClassifyTest(unittest.TestCase):
    def test_states(self) -> None:
        self.assertEqual(dbctl.classify(instance("RUNNABLE", "ALWAYS")), "running")
        self.assertEqual(dbctl.classify(instance("MAINTENANCE", "ALWAYS")), "starting")
        self.assertEqual(dbctl.classify(instance("STOPPED", "NEVER")), "stopped")
        # 実際の API は、停止中でも state=RUNNABLE・稼働ポリシー=NEVER を返す
        self.assertEqual(dbctl.classify(instance("RUNNABLE", "NEVER")), "stopped")
        self.assertEqual(dbctl.classify(instance("MAINTENANCE", "NEVER")), "stopping")
        self.assertEqual(dbctl.classify({}), "unknown")


class ControllerTest(unittest.IsolatedAsyncioTestCase):
    async def test_running_passes(self) -> None:
        c = Fake(instance("RUNNABLE", "ALWAYS"))
        await c.ensure_running()
        self.assertEqual(c.policies, [])

    async def test_stopped_requests_start_once_and_reports_not_ready(self) -> None:
        c = Fake(instance("RUNNABLE", "NEVER"))
        with self.assertRaises(dbctl.DbNotReady):
            await c.ensure_running()
        self.assertEqual(c.policies, ["ALWAYS"])
        # 起動の依頼のあと(キャッシュの間)は、重ねて依頼しない
        with self.assertRaises(dbctl.DbNotReady):
            await c.ensure_running()
        self.assertEqual(c.policies, ["ALWAYS"])

    async def test_idle_check_stops_after_idle_time(self) -> None:
        c = Fake(instance("RUNNABLE", "ALWAYS"), last=time.time() - 31 * 60)
        r = await c.idle_check(30)
        self.assertEqual(r["action"], "stop")
        self.assertEqual(c.policies, ["NEVER"])

    async def test_idle_check_keeps_running_when_recently_used(self) -> None:
        c = Fake(instance("RUNNABLE", "ALWAYS"), last=time.time() - 5 * 60)
        r = await c.idle_check(30)
        self.assertEqual(r["action"], "none")
        self.assertEqual(c.policies, [])

    async def test_idle_check_gives_grace_when_no_record(self) -> None:
        c = Fake(instance("RUNNABLE", "ALWAYS"), last=None)
        r = await c.idle_check(30)
        self.assertEqual(r["action"], "none")
        self.assertIsNotNone(c.last)
        self.assertEqual(c.policies, [])

    async def test_idle_check_does_nothing_when_not_running(self) -> None:
        c = Fake(instance("RUNNABLE", "NEVER"), last=time.time() - 999 * 60)
        r = await c.idle_check(30)
        self.assertEqual(r["action"], "none")
        self.assertEqual(c.policies, [])

    async def test_touch_is_throttled(self) -> None:
        c = Fake(instance("RUNNABLE", "ALWAYS"))
        await c.touch()
        first = c.last
        time.sleep(0.01)
        await c.touch()
        self.assertEqual(c.last, first)


if __name__ == "__main__":
    unittest.main()
