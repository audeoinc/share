# cdock explorer (Windows / PowerShell 5.1+ 標準機能のみ)
# Enter: @path をクリップボードへ  Space: 複数選択  A: 選択を一括コピー  → ←: 開閉  H: 隠しファイル  R: 更新  Q: 終了
param([string]$Root = '.')
$Root = (Resolve-Path -LiteralPath $Root).Path
$esc = [char]27
$ignore = '.git', 'node_modules', '__pycache__', '.venv'
$open = [System.Collections.Generic.HashSet[string]]::new()
[void]$open.Add($Root)
$marked = [System.Collections.Generic.List[string]]::new()
$showHidden = $false
$sel = 0; $top = 0; $msg = ''

function Get-GitStatus {
    $h = @{}
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $h }
    $top = (git -C $Root rev-parse --show-toplevel 2>$null)
    if (-not $top) { return $h }
    foreach ($l in (git -C $Root status --porcelain -uall 2>$null)) {
        if ($l.Length -lt 4) { continue }
        $p = $l.Substring(3).Trim('"'); if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1] }
        $full = [System.IO.Path]::GetFullPath((Join-Path $top $p))
        $h[$full] = $l.Substring(0, 2).Trim()[0]
        $d = Split-Path $full -Parent
        while ($d -and $d.Length -gt $Root.Length -and $d.StartsWith($Root)) { if (-not $h.ContainsKey($d)) { $h[$d] = [char]0x2022 }; $d = Split-Path $d -Parent }
    }
    $h
}

function Build-Rows {
    $script:rows = [System.Collections.Generic.List[object]]::new()
    function Walk($dir, $depth) {
        $items = Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |
            Where-Object { $ignore -notcontains $_.Name -and ($showHidden -or -not $_.Name.StartsWith('.')) } |
            Sort-Object @{e = { -not $_.PSIsContainer } }, Name
        foreach ($i in $items) {
            $script:rows.Add([pscustomobject]@{ Path = $i.FullName; Depth = $depth; Dir = $i.PSIsContainer })
            if ($i.PSIsContainer -and $open.Contains($i.FullName)) { Walk $i.FullName ($depth + 1) }
        }
    }
    Walk $Root 0
}

function Refresh { $script:git = Get-GitStatus; Build-Rows; if ($script:sel -ge $script:rows.Count) { $script:sel = [Math]::Max(0, $script:rows.Count - 1) } }
function Ref($p) { $r = $p.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/'); if ($r -match ' ') { "@`"$r`"" } else { "@$r" } }
function Cut($s, $w) { if ($s.Length -gt $w) { $s.Substring(0, [Math]::Max(0, $w)) } else { $s } }

function Draw {
    $w = [Console]::WindowWidth; $h = [Console]::WindowHeight; $body = $h - 3
    if ($sel -lt $top) { $script:top = $sel }
    if ($sel -ge $top + $body) { $script:top = $sel - $body + 1 }
    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.Append("$esc[?25l$esc[H$esc[1;34m $(Cut (Split-Path $Root -Leaf) ($w - 3))/$esc[0m$esc[K`n")
    for ($i = 0; $i -lt $body; $i++) {
        $idx = $top + $i
        if ($idx -ge $rows.Count) { [void]$sb.Append("$esc[K`n"); continue }
        $r = $rows[$idx]
        $mk = if ($marked.Contains($r.Path)) { [char]0x2713 } else { ' ' }
        $ic = if ($r.Dir) { if ($open.Contains($r.Path)) { "$([char]0x25BE) " } else { "$([char]0x25B8) " } } else { '  ' }
        $line = Cut ("$mk" + ('  ' * $r.Depth) + $ic + (Split-Path $r.Path -Leaf)) ($w - 3)
        $st = $git[$r.Path]
        $col = if ($r.Dir) { '34' } elseif ($st) { '33' } else { '0' }
        $rev = if ($idx -eq $sel) { '7;' } else { '' }
        [void]$sb.Append("$esc[${rev}${col}m$($line.PadRight($w - 3))$st$esc[0m$esc[K`n")
    }
    $status = if ($msg) { $msg } else { "$($marked.Count) marked | Enter:copy @path  Space:mark  A:all  Q:quit" }
    [void]$sb.Append("$esc[2m$(Cut $status ($w - 1))$esc[0m$esc[K")
    [Console]::Out.Write($sb.ToString())
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Clear-Host; Refresh
try {
    while ($true) {
        Draw; $msg = ''
        if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 30; if (-not [Console]::KeyAvailable) { continue } }
        $k = [Console]::ReadKey($true)
        $cur = if ($rows.Count) { $rows[$sel] } else { $null }
        switch ($k.Key) {
            'Q' { return }
            'Escape' { return }
            'DownArrow' { $sel = [Math]::Min($sel + 1, $rows.Count - 1) }
            'J' { $sel = [Math]::Min($sel + 1, $rows.Count - 1) }
            'UpArrow' { $sel = [Math]::Max($sel - 1, 0) }
            'K' { $sel = [Math]::Max($sel - 1, 0) }
            { $_ -in 'RightArrow', 'L' } { if ($cur -and $cur.Dir) { [void]$open.Add($cur.Path); Refresh } }
            { $_ -in 'LeftArrow', 'H' } {
                if ($cur) {
                    if ($cur.Dir -and $open.Contains($cur.Path)) { [void]$open.Remove($cur.Path) }
                    else { $par = Split-Path $cur.Path -Parent; for ($i = 0; $i -lt $rows.Count; $i++) { if ($rows[$i].Path -eq $par) { $sel = $i } } }
                    Refresh
                }
            }
            'Enter' {
                if ($cur) {
                    if ($cur.Dir) { if (-not $open.Remove($cur.Path)) { [void]$open.Add($cur.Path) }; Refresh }
                    else { Set-Clipboard -Value ((Ref $cur.Path) + ' '); $msg = "copied $(Ref $cur.Path) -> Claude で Ctrl+V" }
                }
            }
            'Spacebar' { if ($cur) { if (-not $marked.Remove($cur.Path)) { $marked.Add($cur.Path) }; $sel = [Math]::Min($sel + 1, $rows.Count - 1) } }
            'A' { if ($marked.Count) { Set-Clipboard -Value ((($marked | ForEach-Object { Ref $_ }) -join ' ') + ' '); $msg = "copied $($marked.Count) files -> Ctrl+V"; $marked.Clear() } }
            'R' { Refresh }
        }
        if ($k.KeyChar -eq '.') { $showHidden = -not $showHidden; Refresh }
    }
} finally { [Console]::Out.Write("$esc[?25h$esc[0m") }
