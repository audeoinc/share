# PowerPoint (COM) でスライドを PNG に書き出す: export-slides.ps1 -Path <pptx> -OutDir <folder> [-Width 1280]
# 読み取り専用・ウィンドウなしで開き、マクロは無効にする。すでに起動中の PowerPoint は閉じない。
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$Width = 1280
)
$ErrorActionPreference = 'Stop'
$wasRunning = [bool](Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
$ppt = $null; $pres = $null; $prevSecurity = $null
try {
    if (-not $wasRunning) { Write-Output 'LAUNCHED' }
    $ppt = New-Object -ComObject PowerPoint.Application
    try { $prevSecurity = $ppt.AutomationSecurity; $ppt.AutomationSecurity = 3 } catch { }  # 3 = msoAutomationSecurityForceDisable (マクロ無効)
    $pres = $ppt.Presentations.Open($Path, -1, 0, 0)  # ReadOnly=True, Untitled=False, WithWindow=False
    $h = [int][Math]::Round($Width * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $pres.Export($OutDir, 'PNG', $Width, $h)
    Write-Output ('OK ' + $pres.Slides.Count)
}
finally {
    if ($pres) { try { $pres.Close() } catch { } }
    if ($ppt -and $null -ne $prevSecurity) { try { $ppt.AutomationSecurity = $prevSecurity } catch { } }
    if ($ppt -and -not $wasRunning) { try { $ppt.Quit() } catch { } }
    if ($pres) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($pres) }
    if ($ppt) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) }
}
