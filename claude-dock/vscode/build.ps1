# VS Code 拡張 (VSIX) を作る。使い方: pwsh -File build.ps1
# 画面と会話の処理は、../web のものをそのまま server\ にコピーして同梱する (Monaco / Mermaid は同梱しない)。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$web = Join-Path $PSScriptRoot '..\web'
$srv = Join-Path $PSScriptRoot 'server'
if (Test-Path -LiteralPath $srv) { [IO.Directory]::Delete($srv, $true) }
New-Item -ItemType Directory -Path $srv | Out-Null
Copy-Item -LiteralPath (Join-Path $web 'server.js'), (Join-Path $web 'links.default.json') -Destination $srv
Copy-Item -LiteralPath (Join-Path $web 'public') -Destination $srv -Recurse
$pj = Get-Content -Raw -LiteralPath (Join-Path $web 'package.json') | ConvertFrom-Json
$deps = [ordered]@{}
foreach ($n in 'ws', 'iconv-lite', '@anthropic-ai/claude-agent-sdk') { $deps[$n] = $pj.dependencies.$n }
$o = [ordered]@{ name = 'crogue-server'; version = $pj.version; private = $true; type = $pj.type; dependencies = $deps }
[IO.File]::WriteAllText((Join-Path $srv 'package.json'), ($o | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
Push-Location $srv
npm install --omit=optional --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'npm install に失敗しました' }
Pop-Location
npx --yes @vscode/vsce package --allow-missing-repository --skip-license --no-dependencies -o crogue.vsix
if ($LASTEXITCODE -ne 0) { throw 'vsce package に失敗しました' }
Get-Item crogue.vsix | ForEach-Object { '{0}  {1:N1} MB' -f $_.FullName, ($_.Length / 1MB) }
