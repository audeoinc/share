"""schema.py(名前・値の変換、絞り込みの解析、テーブルを作る SQL)の単体テスト。DB には接続しない。

  cd server && python -m unittest discover tests
"""
from __future__ import annotations

import sys
import unittest
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ccp import schema as sc  # noqa: E402

GUID = "3f2c3d3e-1111-4a2b-8c3d-5e6f7a8b9c0d"


class SchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.s = sc.load()

    def test_every_lookup_points_to_a_table(self) -> None:
        for t in self.s.tables.values():
            for lk in t.lookups:
                self.assertIn(lk.ref, self.s.tables, f"{t.dv}.{lk.dv}")

    def test_creation_order_puts_referenced_tables_first(self) -> None:
        names = [t.dv for t in self.s.creation_order()]
        for t in self.s.tables.values():
            for lk in t.lookups:
                self.assertLess(names.index(lk.ref), names.index(t.dv))

    def test_ddl_has_no_dataverse_prefix(self) -> None:
        self.assertFalse(any("cr854_" in stmt for stmt in self.s.ddl()))

    def test_to_db_resolves_bind_and_ignores_primary_key(self) -> None:
        t = self.s.table("cr854_deliveryproducts")
        v = t.to_db({"cr854_deliveryproductid": GUID, "cr854_name": "x", "cr854_deliverycard@odata.bind": f"/cr854_deliverycards({GUID})", "cr854_sortorder": "2", "statecode": 0})
        self.assertEqual(v, {"name": "x", "delivery_card_id": uuid.UUID(GUID), "sort_order": 2, "state_code": 0})

    def test_bind_null_clears_the_reference(self) -> None:
        t = self.s.table("cr854_deliverycards")
        self.assertEqual(t.to_db({"cr854_heroimage@odata.bind": None}), {"hero_image_id": None})

    def test_unknown_field_is_rejected_but_admin_fields_are_ignored(self) -> None:
        t = self.s.table("cr854_products")
        with self.assertRaises(sc.BadRequest):
            t.to_db({"cr854_nope": 1})
        self.assertEqual(t.to_db({"ownerid": "x", "statuscode": 1}), {})

    def test_to_api_uses_dataverse_names_and_formats(self) -> None:
        t = self.s.table("cr854_deliverycards")
        row = {
            "id": uuid.UUID(GUID),
            "name": "n",
            "scheduled_at": datetime(2026, 10, 2, 1, 0, tzinfo=timezone.utc),
            "country": 588230000,
            "hero_image_id": uuid.UUID(GUID),
            "state_code": 0,
        }
        out = t.to_api(row)
        self.assertEqual(out["cr854_deliverycardid"], GUID)
        self.assertEqual(out["cr854_scheduledat"], "2026-10-02T01:00:00Z")
        self.assertEqual(out["_cr854_heroimage_value"], GUID)
        self.assertEqual(out["statecode"], 0)

    def test_numbers_serialize_as_int_or_float(self) -> None:
        self.assertEqual(sc.serialize(Decimal("9800.00")), 9800)
        self.assertEqual(sc.serialize(Decimal("4.70")), 4.7)

    def test_filter_eq_with_quote_escape_and_and(self) -> None:
        t = self.s.table("cr854_productpolicies")
        sql, params = sc.parse_filter(t, "cr854_productcode eq 'P''07' and cr854_stage eq 'x'")
        self.assertEqual(sql, "product_code = :f0 AND stage = :f1")
        self.assertEqual(params, {"f0": "P'07", "f1": "x"})

    def test_filter_on_lookup_value_uses_uuid(self) -> None:
        t = self.s.table("cr854_deliveryproducts")
        sql, params = sc.parse_filter(t, f"_cr854_deliverycard_value eq {GUID}")
        self.assertEqual(sql, "delivery_card_id = :f0")
        self.assertEqual(params["f0"], uuid.UUID(GUID))

    def test_filter_rejects_unsupported_syntax_and_sql_injection(self) -> None:
        t = self.s.table("cr854_products")
        for bad in ["cr854_name eq 'a' or 1 eq 1", "cr854_name eq 'a'; drop table products", "contains(cr854_name,'a')", "nope eq 1"]:
            with self.assertRaises(sc.BadRequest, msg=bad):
                sc.parse_filter(t, bad)

    def test_order_by(self) -> None:
        t = self.s.table("cr854_deliverycards")
        self.assertEqual(sc.parse_order(t, ["cr854_scheduledat asc,createdon desc"]), "scheduled_at ASC, created_on DESC")
        with self.assertRaises(sc.BadRequest):
            sc.parse_order(t, ["cr854_scheduledat sideways"])


if __name__ == "__main__":
    unittest.main()
