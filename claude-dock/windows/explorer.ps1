# cdock explorer (Windows / PowerShell 5.1+ 標準機能のみ)
# Enter: @path をクリップボードへ  Space: 複数選択  A: 選択を一括コピー  → ←: 開閉  H: 隠しファイル  R: 更新  Q: 終了
param([string]$Root = '.')
$Root = (Resolve-Path -LiteralPath $Root).Path
$esc = [char]27
# Claude desktop 風パレット (24bit)
function Fg($r, $g, $b) { "$esc[38;2;$r;$g;${b}m" }
function Bg($r, $g, $b) { "$esc[48;2;$r;$g;${b}m" }
$cText = Fg 61 57 41; $cMuted = Fg 140 136 120; $cRule = Fg 221 216 200; $cAccent = Fg 201 100 66
$cMod = Fg 183 121 31; $cNew = Fg 76 140 74; $cDel = Fg 192 57 43; $cRen = Fg 59 111 160
$bgBase = Bg 250 249 245; $bgSel = Bg 237 233 221; $rst = "$esc[0m$bgBase"
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
function Wd($s) {
    $n = 0
    foreach ($c in $s.ToCharArray()) {
        $v = [int]$c
        if (($v -ge 0x1100 -and $v -le 0x115F) -or ($v -ge 0x2E80 -and $v -le 0xA4CF) -or ($v -ge 0xAC00 -and $v -le 0xD7A3) -or ($v -ge 0xF900 -and $v -le 0xFAFF) -or ($v -ge 0xFE30 -and $v -le 0xFE6F) -or ($v -ge 0xFF00 -and $v -le 0xFF60) -or ($v -ge 0xFFE0 -and $v -le 0xFFE6)) { $n += 2 } else { $n++ }
    }
    $n
}
function Cut($s, $w) {
    if ($w -le 0) { return '' }
    if ((Wd $s) -le $w) { return $s }
    $o = [System.Text.StringBuilder]::new(); $n = 0
    foreach ($c in $s.ToCharArray()) { $cw = Wd ([string]$c); if ($n + $cw -gt $w - 1) { break }; [void]$o.Append($c); $n += $cw }
    $o.ToString() + [char]0x2026
}
function Git-Color($st) {
    switch ("$st") { 'M' { $cMod } 'A' { $cNew } '?' { $cNew } 'D' { $cDel } 'R' { $cRen } default { $cMuted } }
}

$script:lastW = 0; $script:lastH = 0
function Draw {
    $w = [Console]::WindowWidth; $h = [Console]::WindowHeight; $body = [Math]::Max(1, $h - 7)
    if ($w -ne $script:lastW -or $h -ne $script:lastH) { [Console]::Out.Write("$bgBase$esc[2J"); $script:lastW = $w; $script:lastH = $h }
    if ($sel -lt $top) { $script:top = $sel }
    if ($sel -ge $top + $body) { $script:top = $sel - $body + 1 }
    $sb = [System.Text.StringBuilder]::new()
    $title = Cut (Split-Path $Root -Leaf) ($w - 6)
    [void]$sb.Append("$esc[?25l$esc[H$bgBase $cAccent$([char]0x25C6) $cText$title$rst$esc[K`n")
    [void]$sb.Append("$bgBase$cRule$([string][char]0x2500 * $w)$rst`n")
    for ($i = 0; $i -lt $body; $i++) {
        $idx = $top + $i
        if ($idx -ge $rows.Count) { [void]$sb.Append("$bgBase$esc[K`n"); continue }
        $r = $rows[$idx]
        $isSel = ($idx -eq $sel)
        $bar = if ($isSel) { "$cAccent$([char]0x258C)" } else { ' ' }
        $mk = if ($marked.Contains($r.Path)) { "$cAccent$([char]0x25CF)" } else { ' ' }
        $ch = if ($r.Dir) { if ($open.Contains($r.Path)) { [char]0x25BE } else { [char]0x25B8 } } else { ' ' }
        $avail = [Math]::Max(1, $w - 4 - (2 * $r.Depth) - 2)
        $name = Cut (Split-Path $r.Path -Leaf) $avail
        $pad = ' ' * [Math]::Max(0, $avail - (Wd $name))
        $st = $git[$r.Path]
        $stc = if ($st) { "$(Git-Color $st)$st" } else { ' ' }
        $nameStyle = $cText
        $bg = if ($isSel) { $bgSel } else { $bgBase }
        [void]$sb.Append("$bg$bar$mk$(' ' * (2 * $r.Depth))$cMuted$ch $nameStyle$name$rst$bg$pad$stc $rst$esc[K`n")
    }
    [void]$sb.Append("$bgBase$cRule$([string][char]0x2500 * $w)$rst`n")
    $line1 = if ($msg) { "$cAccent$(Cut $msg ($w - 2))" }
             elseif ($marked.Count) { "$cAccent$(Cut "$($marked.Count) marked  A:copy all" ($w - 2))" }
             else { "$cMuted$(Cut 'Enter:copy' ($w - 2))" }
    [void]$sb.Append("$bgBase $line1$rst$esc[K`n")
    [void]$sb.Append("$bgBase $cMuted$(Cut 'Space:mark' ($w - 2))$rst$esc[K`n")
    [void]$sb.Append("$bgBase $cMuted$(Cut "$([char]0x2190)$([char]0x2192):open  .:hide" ($w - 2))$rst$esc[K`n")
    [void]$sb.Append("$bgBase $cMuted$(Cut 'R:refresh Q:quit' ($w - 2))$rst$esc[K")
    [Console]::Out.Write($sb.ToString())
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# コンソール入力 (キー + マウス)。ReadConsoleInput を直接使う
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CdockCon {
    [StructLayout(LayoutKind.Explicit)] public struct KEY { [FieldOffset(0)] public int down; [FieldOffset(4)] public ushort repeat; [FieldOffset(6)] public ushort vk; [FieldOffset(8)] public ushort scan; [FieldOffset(10)] public char ch; [FieldOffset(12)] public uint ctrl; }
    [StructLayout(LayoutKind.Explicit)] public struct MOUSE { [FieldOffset(0)] public short x; [FieldOffset(2)] public short y; [FieldOffset(4)] public uint buttons; [FieldOffset(8)] public uint ctrl; [FieldOffset(12)] public uint flags; }
    [StructLayout(LayoutKind.Explicit)] public struct REC { [FieldOffset(0)] public ushort type; [FieldOffset(4)] public KEY key; [FieldOffset(4)] public MOUSE mouse; }
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
    [DllImport("kernel32.dll")] public static extern bool GetNumberOfConsoleInputEvents(IntPtr h, out uint n);
    [DllImport("kernel32.dll", EntryPoint="ReadConsoleInputW")] public static extern bool ReadConsoleInput(IntPtr h, [Out] REC[] b, uint len, out uint read);
}
"@
$hIn = [CdockCon]::GetStdHandle(-10)
[uint32]$oldMode = 0; [void][CdockCon]::GetConsoleMode($hIn, [ref]$oldMode)
# マウス入力 ON / クイック編集 OFF / VT 入力 OFF
[void][CdockCon]::SetConsoleMode($hIn, (($oldMode -bor 0x10 -bor 0x80) -band (-bnot 0x40) -band (-bnot 0x200)))
$recBuf = New-Object 'CdockCon+REC[]' 1

function Copy-Ref($p) { Set-Clipboard -Value ((Ref $p) + ' '); $script:msg = "$([char]0x2713) copied $(Ref $p)  -  Ctrl+V in Claude" }
function Move-Sel($d) { $script:sel = [Math]::Max(0, [Math]::Min($script:sel + $d, $script:rows.Count - 1)) }

[Console]::Out.Write("$bgBase$esc[2J"); Refresh
$dirty = $true
try {
    while ($true) {
        if ($dirty) { Draw; $dirty = $false }
        [uint32]$n = 0; [void][CdockCon]::GetNumberOfConsoleInputEvents($hIn, [ref]$n)
        if ($n -eq 0) { Start-Sleep -Milliseconds 20; continue }
        [uint32]$read = 0; [void][CdockCon]::ReadConsoleInput($hIn, $recBuf, 1, [ref]$read)
        if ($read -eq 0) { continue }
        $ev = $recBuf[0]
        $dirty = $true; $msg = ''
        $cur = if ($rows.Count) { $rows[$sel] } else { $null }

        if ($ev.type -eq 2) {
            # マウス: クリックで選択/フォルダ開閉、ダブルクリックでファイルをコピー、ホイールでスクロール
            $m = $ev.mouse
            if (($m.flags -band 4) -ne 0) {
                $delta = [int][int16]($m.buttons -shr 16)
                if ($delta -gt 0) { Move-Sel -3 } else { Move-Sel 3 }
            }
            elseif (($m.buttons -band 1) -ne 0 -and ($m.flags -band 1) -eq 0) {
                $idx = $top + ($m.y - [Console]::WindowTop) - 2
                if ($idx -ge $top -and $idx -lt $rows.Count -and ($idx - $top) -lt ([Console]::WindowHeight - 7)) {
                    $sel = $idx; $r = $rows[$idx]
                    if ($r.Dir) {
                        if (($m.flags -band 2) -eq 0) { if (-not $open.Remove($r.Path)) { [void]$open.Add($r.Path) }; Refresh }
                    }
                    elseif (($m.flags -band 2) -ne 0) { Copy-Ref $r.Path }
                }
            }
            continue
        }
        if ($ev.type -ne 1 -or $ev.key.down -eq 0) { $dirty = $false; continue }

        $k = [pscustomobject]@{ Key = [System.ConsoleKey][int]$ev.key.vk; KeyChar = $ev.key.ch }
        switch ($k.Key) {
            'Q' { return }
            'Escape' { return }
            'DownArrow' { Move-Sel 1 }
            'J' { Move-Sel 1 }
            'UpArrow' { Move-Sel -1 }
            'K' { Move-Sel -1 }
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
                    else { Copy-Ref $cur.Path }
                }
            }
            'Spacebar' { if ($cur) { if (-not $marked.Remove($cur.Path)) { $marked.Add($cur.Path) }; Move-Sel 1 } }
            'A' { if ($marked.Count) { Set-Clipboard -Value ((($marked | ForEach-Object { Ref $_ }) -join ' ') + ' '); $msg = "$([char]0x2713) copied $($marked.Count) files  -  Ctrl+V in Claude"; $marked.Clear() } }
            'R' { Refresh }
        }
        if ($k.KeyChar -eq '.') { $showHidden = -not $showHidden; Refresh }
    }
} finally { [void][CdockCon]::SetConsoleMode($hIn, $oldMode); [Console]::Out.Write("$esc[?25h$esc[0m") }
