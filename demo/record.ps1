# aulos 演示视频录制脚本
# 用法:
#   ./record.ps1 -Name desktop            # 全屏 2K 录制 (默认 2560x1440)
#   ./record.ps1 -Name mcp -W 1920 -H 1080 # 指定区域
#   ./record.ps1 -Name desktop -Title "aulos"  # 按窗口标题自动定位(窗口录制期间别移动)
# 停止: 在本窗口按 Ctrl+C (或按 q)。输出: demo/raw/<Name>_<时间戳>.mp4
param(
  [string]$Name = "clip",
  [string]$Title = "",
  [int]$X = 0, [int]$Y = 0, [int]$W = 2560, [int]$H = 1440,
  [int]$Fps = 30
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "ffmpeg 未安装。先运行: winget install Gyan.FFmpeg (装完重开终端)" -ForegroundColor Red
  exit 1
}

if ($Title) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Rec {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
  $h = [Win32Rec]::FindWindow($null, $Title)
  if ($h -eq [IntPtr]::Zero) { Write-Host "找不到窗口: $Title" -ForegroundColor Red; exit 1 }
  $r = New-Object Win32Rec+RECT
  [Win32Rec]::GetWindowRect($h, [ref]$r) | Out-Null
  $X, $Y, $W, $H = $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T)
  Write-Host "定位窗口 '$Title': ${W}x${H} @($X,$Y)"
}

$outDir = Join-Path $PSScriptRoot "raw"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$out = Join-Path $outDir "${Name}_$stamp.mp4"

Write-Host ""
Write-Host "=== 3 秒后开始录制区域 ($X,$Y) ${W}x${H} @$Fps fps ===" -ForegroundColor Green
Write-Host "=== 停止: 回到本窗口按 Ctrl+C（会等 ffmpeg 正常收尾再退出）==="
Start-Sleep -Seconds 3

# -t 600: 兜底 10 分钟上限，防止忘停产生巨大文件; Ctrl+C 触发 ffmpeg 正常收尾写 moov
ffmpeg -f gdigrab -framerate $Fps -offset_x $X -offset_y $Y -video_size "${W}x${H}" `
       -i desktop -t 600 -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p "$out"

Write-Host "已保存: $out" -ForegroundColor Green
