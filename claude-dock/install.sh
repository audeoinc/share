#!/usr/bin/env bash
# cdock を PATH に通す (デフォルト ~/.local/bin)。別環境へはこのディレクトリごとコピーして実行。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/.local/bin}"
mkdir -p "$DEST"
ln -sf "$HERE/bin/cdock" "$DEST/cdock"
echo "installed: $DEST/cdock"
case ":$PATH:" in *":$DEST:"*) ;; *) echo "注意: $DEST が PATH にありません" ;; esac
for c in tmux python3 claude; do command -v $c >/dev/null || echo "未インストール: $c"; done
