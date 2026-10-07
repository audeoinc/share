# Claude Rogue を配布用の ZIP にまとめる (node_modules は含めない。移行先で start.cmd が npm install します)
# 使い方: pwsh -File pack.ps1   →  release\crogue.zip (git に入れて受け渡しに使う)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$files = git ls-files . 2>$null
if (-not $files) { throw 'git で管理されているファイルが見つかりません (リポジトリの中で実行してください)' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('crogue-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $stage 'crogue'
try {
  foreach ($f in $files) {
    if ($f -eq 'pack.ps1' -or $f -eq '.gitignore' -or $f -like 'release/*') { continue }
    $dest = Join-Path $root $f
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -LiteralPath $f -Destination $dest
  }
  New-Item -ItemType Directory -Force -Path release | Out-Null
  $zip = Join-Path $PSScriptRoot 'release\crogue.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $root -DestinationPath $zip
  $kb = [math]::Round((Get-Item $zip).Length / 1KB)
  Write-Host "作成しました: $zip ($kb KB)"
  Write-Host '移行先: 展開して crogue\start.cmd [作業フォルダ] を実行 (初回は npm install が走ります)'
} finally { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
