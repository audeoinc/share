# Claude Rogue を配布用の ZIP にまとめる (node_modules は含めない。初回の start.cmd が npm install します)
# 使い方: pwsh -File pack.ps1
#   release\crogue.zip        通常版 (Claude Code 本体を同梱)
#   release\crogue-light.zip  ライト版 (PC の Claude Code を使う。同梱しないので約 250MB 小さい)
# ZIP の中の構成:
#   crogue\start.cmd   ダブルクリックで起動 (pkg\start.cmd / pkg\start-light.cmd が元)
#   crogue\app\        それ以外のすべて (server.js、public\、package.json、README.md など。初回の起動で node_modules もここにできる)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$files = git ls-files . 2>$null
if (-not $files) { throw 'git で管理されているファイルが見つかりません (リポジトリの中で実行してください)' }
New-Item -ItemType Directory -Force -Path release | Out-Null

function New-Package([string]$zipName, [bool]$light) {
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('crogue-' + [guid]::NewGuid().ToString('N'))
  $root = Join-Path $stage 'crogue'
  $app = Join-Path $root 'app'
  try {
    foreach ($f in $files) {
      if ($f -eq 'pack.ps1' -or $f -eq '.gitignore' -or $f -like 'release/*' -or $f -like 'pkg/*') { continue }
      if ($f -eq 'start.cmd' -or $f -eq 'start-light.cmd') { continue }   # 開発用の起動ファイル。配布物では、pkg の起動ファイルを使う
      $dest = Join-Path $app $f
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      Copy-Item -LiteralPath $f -Destination $dest
    }
    $launcher = if ($light) { 'pkg\start-light.cmd' } else { 'pkg\start.cmd' }
    Copy-Item -LiteralPath $launcher -Destination (Join-Path $root 'start.cmd')
    if ($light) {
      $note = @'
> **ライト版**: PC にインストール済みの Claude Code を使います (Claude Code 本体は同梱しません)。
> - 必要なもの: Node.js、Claude Code (2.1.293 を推奨。claude.exe が見つかること)
> - 起動: `start.cmd` をダブルクリック (初回だけ `npm install` が走ります。約 340MB、1〜2 分)
> - Claude Code が見つからないときは、メッセージを出して終了します。環境変数 `CDOCK_CLAUDE_PATH` に claude.exe のパスを指定すれば、使うものを選べます

'@
      $readme = Join-Path $app 'README.md'
      $text = [IO.File]::ReadAllText($readme)
      $nl = $text.IndexOf("`n")
      [IO.File]::WriteAllText($readme, $text.Substring(0, $nl + 1) + "`n" + $note + $text.Substring($nl + 1), (New-Object Text.UTF8Encoding($false)))
    }
    $zip = Join-Path $PSScriptRoot "release\$zipName"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path $root -DestinationPath $zip
    $kb = [math]::Round((Get-Item $zip).Length / 1KB)
    Write-Host "作成しました: $zip ($kb KB)"
  } finally { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
}

New-Package 'crogue.zip' $false
New-Package 'crogue-light.zip' $true
Write-Host '移行先: 展開して crogue\start.cmd をダブルクリック (初回は npm install が走ります。ブラウザが自動で開きます)'
