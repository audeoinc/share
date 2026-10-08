# Claude Rogue を配布用の ZIP (release\crogue.zip) にまとめる。node_modules は含めない (初回の start.cmd が npm install します)。
# 配布版は、PC にインストール済みの Claude Code を使う (Claude Code 本体は同梱しない)。
# 使い方: pwsh -File pack.ps1
# ZIP の中の構成:
#   crogue\start.cmd   ダブルクリックで起動 (元は pkg\start.cmd)
#   crogue\README.md   使い方ガイド (元は pkg\README.md)
#   crogue\app\        それ以外のすべて (server.js、public\、package.json、README.md など。初回の起動で node_modules もここにできる)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$files = git ls-files . 2>$null
if (-not $files) { throw 'git で管理されているファイルが見つかりません (リポジトリの中で実行してください)' }
New-Item -ItemType Directory -Force -Path release | Out-Null

$stage = Join-Path ([IO.Path]::GetTempPath()) ('crogue-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $stage 'crogue'
$app = Join-Path $root 'app'
try {
  foreach ($f in $files) {
    if ($f -eq 'pack.ps1' -or $f -eq '.gitignore' -or $f -like 'release/*' -or $f -like 'pkg/*') { continue }
    if (-not (Test-Path -LiteralPath $f)) { continue }   # 削除済みで、まだコミットしていないファイル
    if ($f -eq 'start.cmd') { continue }   # 開発用の起動ファイル (Claude Code 本体を同梱して動かす)。配布物では pkg\start.cmd を使う
    $dest = Join-Path $app $f
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -LiteralPath $f -Destination $dest
  }
  Copy-Item -LiteralPath 'pkg\start.cmd' -Destination (Join-Path $root 'start.cmd')
  Copy-Item -LiteralPath 'pkg\README.md' -Destination (Join-Path $root 'README.md')
  $zip = Join-Path $PSScriptRoot 'release\crogue.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $root -DestinationPath $zip
  $kb = [math]::Round((Get-Item $zip).Length / 1KB)
  Write-Host "作成しました: $zip ($kb KB)"
  Write-Host '移行先: 展開して crogue\start.cmd をダブルクリック (初回は npm install が走ります。ブラウザが自動で開きます)'
} finally { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
