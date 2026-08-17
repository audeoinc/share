#!/usr/bin/env bash
#
# ビルド成果物を GCS に配置する。
#
#   GCS_BUCKET=my-bucket ./deploy.sh
#   GCS_BUCKET=my-bucket GCS_PREFIX=viz/ddl-diff ./deploy.sh
#
# Looker Studio のレポート編集画面で「コミュニティ ビジュアリゼーションとコンポーネント」→
# 「+ 独自の作成物を追加」に、最後に表示される gs:// パスを貼り付ける。
set -euo pipefail

: "${GCS_BUCKET:?GCS_BUCKET を指定してください（例: GCS_BUCKET=my-bucket ./deploy.sh）}"
GCS_PREFIX="${GCS_PREFIX:-viz/ddl-diff}"
GCS_PREFIX="${GCS_PREFIX%/}"

URI_BASE="gs://${GCS_BUCKET}/${GCS_PREFIX}"
HTTPS_BASE="https://storage.googleapis.com/${GCS_BUCKET}/${GCS_PREFIX}"

cd "$(dirname "$0")"

echo "==> build"
npm run build

echo "==> manifest (${URI_BASE})"
sed -e "s#GCS_URI_BASE#${URI_BASE}#g" \
    -e "s#GCS_HTTPS_BASE#${HTTPS_BASE}#g" \
    src/manifest.json > dist/manifest.json

echo "==> upload"
# no-cache を付けないと、更新しても Looker Studio が古い JS を掴み続ける
# （Looker Studio 側のキャッシュは manifest の devMode で制御する。別レイヤー）
gcloud storage cp \
  --cache-control="no-cache, max-age=0" \
  dist/manifest.json dist/index.js dist/index.json dist/index.css dist/icon.png \
  "${URI_BASE}/"

echo
echo "デプロイ完了。Looker Studio に貼り付けるパス:"
echo "  ${URI_BASE}"
echo
echo "レポート閲覧者がバケットを読める必要があります。未設定なら次のいずれかを実施してください:"
echo "  # 組織内に限定（推奨）"
echo "  gcloud storage buckets add-iam-policy-binding gs://${GCS_BUCKET} \\"
echo "    --member=domain:example.co.jp --role=roles/storage.objectViewer"
echo "  # 一般公開（社外にも DDL が見えるため通常は不可）"
echo "  gcloud storage buckets add-iam-policy-binding gs://${GCS_BUCKET} \\"
echo "    --member=allUsers --role=roles/storage.objectViewer"
