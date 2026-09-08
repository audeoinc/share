#!/usr/bin/env bash
# 07: 実行「前」にスキャン量を確認する（課金なし）
#
#   ./07_dry_run.sh audeodb query.sql
#
# --dry_run は実際にはクエリを走らせず、スキャン予定バイト数だけを返す。
# 費用を「確認」するより、走らせる前に止めるほうが効く。
set -euo pipefail

PROJECT="${1:?usage: 07_dry_run.sh <project_id> <sql_file>}"
SQL_FILE="${2:?usage: 07_dry_run.sh <project_id> <sql_file>}"

bq query \
  --project_id="${PROJECT}" \
  --use_legacy_sql=false \
  --dry_run \
  < "${SQL_FILE}"

# 参考: 上限バイト数を超えたらジョブごと失敗させる（想定外の全スキャン対策）
#   bq query --project_id="${PROJECT}" --use_legacy_sql=false \
#            --maximum_bytes_billed=1000000000 < "${SQL_FILE}"
