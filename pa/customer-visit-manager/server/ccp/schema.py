"""データ定義(schema.json)の読み込みと、名前・値の変換。

画面(Power Apps 版と共通のコード)は、Dataverse の名前(cr854_scheduledat、_cr854_heroimage_value など)で
読み書きする。PostgreSQL 側は、読みやすい名前(scheduled_at、hero_image_id)にする。
この変換を、ここ 1 か所に集める。テーブルを作る SQL も、触ってよい列の許可リストも、ここから作る。
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.json"

SQL_TYPES = {
    "text": "text",
    "int": "integer",
    "numeric": "numeric(14,2)",
    "timestamptz": "timestamptz",
    "date": "date",
    "choice": "integer",  # Dataverse の選択肢の値は 588230000 など大きい数なので、smallint には入らない
}

# どのテーブルにもある列(画面は、statecode / createdon / modifiedon だけを使う)
SYSTEM_COLUMNS = [("statecode", "state_code", "int"), ("createdon", "created_on", "timestamptz"), ("modifiedon", "modified_on", "timestamptz")]

# 書き込みのときに、あっても無視してよい列(Dataverse の管理用の列)
IGNORED_ON_WRITE = {"ownerid", "statuscode", "versionnumber", "importsequencenumber", "overriddencreatedon", "timezoneruleversionnumber", "utcconversiontimezonecode", "createdon", "modifiedon"}


class BadRequest(ValueError):
    """依頼の内容が正しくない(400 で返す)"""


@dataclass
class Column:
    dv: str
    pg: str
    type: str
    required: bool = False
    index: bool = False


@dataclass
class Lookup:
    dv: str  # 例: cr854_heroimage
    pg: str  # 例: hero_image_id
    ref: str  # 参照先のテーブル(Dataverse の名前)
    on_delete: str = "NO ACTION"

    @property
    def value_key(self) -> str:
        return f"_{self.dv}_value"

    @property
    def bind_key(self) -> str:
        return f"{self.dv}@odata.bind"


@dataclass
class Table:
    dv: str
    pg: str
    pk: str
    columns: list[Column]
    lookups: list[Lookup]
    by_dv: dict[str, Column] = field(default_factory=dict)
    by_lookup_key: dict[str, Lookup] = field(default_factory=dict)

    def __post_init__(self) -> None:
        cols = self.columns + [Column(dv, pg, t) for dv, pg, t in SYSTEM_COLUMNS]
        self.by_dv = {c.dv: c for c in cols}
        for lk in self.lookups:
            self.by_lookup_key[lk.value_key] = lk
            self.by_lookup_key[lk.bind_key] = lk

    @property
    def all_columns(self) -> list[Column]:
        return list(self.by_dv.values())

    # ---- 列の解決(画面の名前 → PostgreSQL の列名と型)
    def resolve(self, name: str) -> tuple[str, str]:
        if name == self.pk:
            return "id", "uuid"
        if name in self.by_dv:
            c = self.by_dv[name]
            return c.pg, c.type
        if name in self.by_lookup_key:
            return self.by_lookup_key[name].pg, "uuid"
        raise BadRequest(f"不明な項目です: {name}")

    # ---- 値の変換(画面から来た値 → PostgreSQL に渡す値)
    def to_db(self, record: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, value in record.items():
            if key == self.pk:
                continue  # 主キーは、DB が決める(指定された値は無視)
            if key in self.by_lookup_key:
                out[self.by_lookup_key[key].pg] = _lookup_id(value)
            elif key in self.by_dv and key not in IGNORED_ON_WRITE:
                c = self.by_dv[key]
                out[c.pg] = coerce(c.type, value)
            elif key in IGNORED_ON_WRITE or not key.startswith("cr854_"):
                continue
            else:
                raise BadRequest(f"不明な項目です: {key}")
        return out

    # ---- 値の変換(PostgreSQL の行 → 画面が使う、Dataverse の形)
    def to_api(self, row: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if "id" in row:
            out[self.pk] = str(row["id"])
        for c in self.all_columns:
            if c.pg in row:
                out[c.dv] = serialize(row[c.pg])
        for lk in self.lookups:
            if lk.pg in row:
                out[lk.value_key] = serialize(row[lk.pg])
        return out

    # ---- テーブルを作る SQL
    def ddl(self) -> list[str]:
        parts = ["id uuid PRIMARY KEY DEFAULT gen_random_uuid()"]
        for c in self.columns:
            parts.append(f"{c.pg} {SQL_TYPES[c.type]}{' NOT NULL' if c.required else ''}")
        for lk in self.lookups:
            ref = _schema().tables[lk.ref].pg
            parts.append(f"{lk.pg} uuid REFERENCES {ref}(id) ON DELETE {lk.on_delete}")
        parts += ["state_code smallint NOT NULL DEFAULT 0", "created_on timestamptz NOT NULL DEFAULT now()", "modified_on timestamptz NOT NULL DEFAULT now()"]
        sql = [f"CREATE TABLE IF NOT EXISTS {self.pg} (\n  " + ",\n  ".join(parts) + "\n)"]
        # 列を足したときに、既存のテーブルにも反映する
        for c in self.columns:
            sql.append(f"ALTER TABLE {self.pg} ADD COLUMN IF NOT EXISTS {c.pg} {SQL_TYPES[c.type]}")
            sql.append(f"ALTER TABLE {self.pg} ALTER COLUMN {c.pg} TYPE {SQL_TYPES[c.type]}")  # 型を変えたときに、既存のテーブルにも反映
        for lk in self.lookups:
            ref = _schema().tables[lk.ref].pg
            sql.append(f"ALTER TABLE {self.pg} ADD COLUMN IF NOT EXISTS {lk.pg} uuid REFERENCES {ref}(id) ON DELETE {lk.on_delete}")
            sql.append(f"CREATE INDEX IF NOT EXISTS ix_{self.pg}_{lk.pg} ON {self.pg}({lk.pg})")
        for c in self.columns:
            if c.index:
                sql.append(f"CREATE INDEX IF NOT EXISTS ix_{self.pg}_{c.pg} ON {self.pg}({c.pg})")
        return sql


@dataclass
class Schema:
    tables: dict[str, Table]

    def table(self, dv_name: str) -> Table:
        try:
            return self.tables[dv_name]
        except KeyError:
            raise BadRequest(f"不明なテーブルです: {dv_name}") from None

    def creation_order(self) -> list[Table]:
        """参照される側を先に作る順(並び替えの結果)"""
        done: list[Table] = []
        seen: set[str] = set()

        def visit(t: Table) -> None:
            if t.dv in seen:
                return
            seen.add(t.dv)
            for lk in t.lookups:
                visit(self.tables[lk.ref])
            done.append(t)

        for t in self.tables.values():
            visit(t)
        return done

    def ddl(self) -> list[str]:
        return [s for t in self.creation_order() for s in t.ddl()]


_cache: Schema | None = None


def _schema() -> Schema:
    global _cache
    if _cache is None:
        raw = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        tables: dict[str, Table] = {}
        for dv, t in raw["tables"].items():
            cols = [Column(c[0], c[1], c[2], **(c[3] if len(c) > 3 else {})) for c in t["columns"]]
            lks = [Lookup(lk[0], lk[1], lk[2], (lk[3] if len(lk) > 3 else {}).get("onDelete", "NO ACTION")) for lk in t["lookups"]]
            tables[dv] = Table(dv, t["pg"], t["pk"], cols, lks)
        _cache = Schema(tables)
    return _cache


def load() -> Schema:
    return _schema()


# ---- 値の変換
def coerce(type_: str, value: Any) -> Any:
    if value is None or value == "":
        return None if type_ != "text" else ("" if value == "" else None)
    try:
        if type_ in ("int", "choice"):
            return int(value)
        if type_ == "numeric":
            return Decimal(str(value))
        if type_ == "timestamptz":
            if isinstance(value, datetime):
                return value
            d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        if type_ == "date":
            return date.fromisoformat(str(value)[:10])
        if type_ == "uuid":
            return uuid.UUID(str(value))
    except (ValueError, ArithmeticError) as e:
        raise BadRequest(f"値の形式が正しくありません: {value!r}") from e
    return str(value)


_GUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def _lookup_id(value: Any) -> uuid.UUID | None:
    """`/cr854_heroimages(<guid>)` や、guid そのものから、ID を取り出す。空なら、参照を外す"""
    if value is None or value == "":
        return None
    m = _GUID.search(str(value))
    if not m:
        raise BadRequest(f"参照の形式が正しくありません: {value!r}")
    return uuid.UUID(m.group(0))


def serialize(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


# ---- OData 風の絞り込み(eq / ne / gt / ge / lt / le を and でつなぐ範囲だけ)
_CLAUSE = re.compile(r"\s*(\w+)\s+(eq|ne|gt|ge|lt|le)\s+('(?:[^']|'')*'|[^\s']+)\s*(?:and\b|$)", re.IGNORECASE)
_OPS = {"eq": "=", "ne": "<>", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}


def parse_filter(table: Table, text: str | None) -> tuple[str, dict[str, Any]]:
    if not text or not text.strip():
        return "", {}
    clauses: list[str] = []
    params: dict[str, Any] = {}
    pos = 0
    while pos < len(text):
        m = _CLAUSE.match(text, pos)
        if not m:
            raise BadRequest(f"絞り込みの書き方に対応していません: {text!r}")
        name, op, raw = m.group(1), m.group(2).lower(), m.group(3)
        col, type_ = table.resolve(name)
        if raw.lower() == "null":
            if op not in ("eq", "ne"):
                raise BadRequest("null は eq / ne だけ使えます")
            clauses.append(f"{col} IS {'NOT ' if op == 'ne' else ''}NULL")
        else:
            val = raw[1:-1].replace("''", "'") if raw.startswith("'") else raw
            key = f"f{len(params)}"
            params[key] = coerce("uuid" if type_ == "uuid" else type_, val)
            clauses.append(f"{col} {_OPS[op]} :{key}")
        pos = m.end()
    return " AND ".join(clauses), params


def parse_order(table: Table, items: list[str] | None) -> str:
    out: list[str] = []
    for item in items or []:
        for part in item.split(","):
            bits = part.split()
            if not bits:
                continue
            col, _ = table.resolve(bits[0])
            direction = bits[1].lower() if len(bits) > 1 else "asc"
            if direction not in ("asc", "desc"):
                raise BadRequest(f"並び順が正しくありません: {part!r}")
            out.append(f"{col} {direction.upper()}")
    return ", ".join(out)
