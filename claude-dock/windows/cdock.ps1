# cdock (Windows): Windows Terminal のペインに Files / Claude / Shell を並べる
# usage: .\cdock.ps1 [dir]     環境変数: CDOCK_CLAUDE (既定 claude)
param([string]$Dir = '.')
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$claude = if ($env:CDOCK_CLAUDE) { $env:CDOCK_CLAUDE } else { 'claude' }
if (-not (Get-Command wt -ErrorAction SilentlyContinue)) { Write-Error 'Windows Terminal (wt) が見つかりません。Microsoft Store の「Windows Terminal」を入れてください。'; exit 1 }
if (-not (Get-Command $claude -ErrorAction SilentlyContinue)) { Write-Error "$claude が見つかりません"; exit 1 }
$ps = 'powershell.exe -NoLogo'
$wtArgs = @(
    "new-tab -d `"$Dir`" --title Files $ps -NoProfile -ExecutionPolicy Bypass -File `"$here\explorer.ps1`" `"$Dir`"",
    "split-pane -V -s 0.78 -d `"$Dir`" --title Claude $ps -NoExit -Command $claude",
    "split-pane -H -s 0.30 -d `"$Dir`" --title Shell $ps"
) -join ' ; '
Start-Process wt -ArgumentList $wtArgs
