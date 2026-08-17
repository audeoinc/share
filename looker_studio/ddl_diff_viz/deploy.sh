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
echo "バケットは一般公開（allUsers に読み取り）が必要です。"
echo "Looker Studio は getThirdPartyScript というサーバー側フェッチャで JS を取得し、"
echo "閲覧者の認証情報を持たないため、ドメイン限定では 403 になります。"
echo "公開されるのはこのビジュアライゼーションのコードだけで、DDL などのデータは"
echo "BigQuery から Looker Studio 経由で iframe に渡るため GCS には一切載りません。"
echo
echo "  gcloud storage buckets add-iam-policy-binding gs://${GCS_BUCKET} \\"
echo "    --member=allUsers --role=roles/storage.objectViewer"
echo
echo "他の用途と同居させないため、viz 資材専用のバケットを使うことを推奨します。"
