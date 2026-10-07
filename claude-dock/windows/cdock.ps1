# cdock (Windows): Windows Terminal のペインに Files / Claude / Shell を並べる
# usage: .\cdock.ps1 [dir]
# 環境変数: CDOCK_CLAUDE (既定 claude) / CDOCK_PROFILE (既定 cdock、空文字で通常プロファイル)
param([string]$Dir = '.')
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$claude = if ($env:CDOCK_CLAUDE) { $env:CDOCK_CLAUDE } else { 'claude' }
if (-not (Get-Command wt -ErrorAction SilentlyContinue)) { Write-Error 'Windows Terminal (wt) が見つかりません。Microsoft Store の「Windows Terminal」を入れてください。'; exit 1 }
if (-not (Get-Command $claude -ErrorAction SilentlyContinue)) { Write-Error "$claude が見つかりません"; exit 1 }

# 専用プロファイル/配色 (Windows Terminal の fragment。settings.json は変更しない)
$profile = if ($null -ne $env:CDOCK_PROFILE) { $env:CDOCK_PROFILE } else { 'cdock' }
if ($profile -eq 'cdock') {
    $fragDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\Fragments\cdock'
    $fragSrc = Join-Path $here 'cdock.fragment.json'
    $fragDst = Join-Path $fragDir 'cdock.json'
    if (-not (Test-Path $fragDst) -or [System.IO.File]::ReadAllText($fragSrc) -ne [System.IO.File]::ReadAllText($fragDst)) {
        New-Item -ItemType Directory -Force $fragDir | Out-Null
        Copy-Item $fragSrc $fragDst -Force
        Copy-Item (Join-Path $here 'cdock-icon.png') (Join-Path $fragDir 'cdock-icon.png') -Force
        Write-Host 'cdock: Windows Terminal の配色を設置しました。反映されない場合は Windows Terminal を再起動してください。'
    }
}
$p = if ($profile) { "-p `"$profile`" " } else { '' }
$name = Split-Path $Dir -Leaf
$t = "--title `"cdock - $name`" --suppressApplicationTitle"
# pwsh (PowerShell 7) があれば優先、無ければ Windows PowerShell 5.1
$ps = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh.exe -NoLogo' } else { 'powershell.exe -NoLogo' }
# Claude Code のテーマはこの起動分だけ claude-settings.json で上書き (--settings)。無効化は CDOCK_CLAUDE_SETTINGS を空文字に
$cs2 = if ($null -ne $env:CDOCK_CLAUDE_SETTINGS) { $env:CDOCK_CLAUDE_SETTINGS } else { "$here\claude-settings.json" }
$claudeCmd = if ($cs2) { "& $claude --settings '$cs2'" } else { $claude }
$wtArgs = @(
    "new-tab $p-d `"$Dir`" $t $ps -NoProfile -ExecutionPolicy Bypass -File `"$here\explorer.ps1`" `"$Dir`"",
    "split-pane $p-V -s 0.74 -d `"$Dir`" $t $ps -NoExit -Command `"$claudeCmd`"",
    "split-pane $p-H -s 0.30 -d `"$Dir`" $t $ps",
    "focus-pane -t 1"
) -join ' ; '
Start-Process wt -ArgumentList $wtArgs
