param(
  [switch]$Loop
)
# 关闭 Windows「打开/Open」文件选择对话框（上传图片时偶尔会弹出挡住浏览器）
# 用法: powershell -File close-file-dialog.ps1          # 检测到就关（一次）
#       powershell -File close-file-dialog.ps1 -Loop    # 持续看护（每 2 秒检测一次）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FdClose {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

function Close-Dialog([string]$Title) {
  $handles = @()
  $h1 = [FdClose]::FindWindow("#32770", $Title)          # 经典文件对话框
  $h2 = [FdClose]::FindWindow("DirectUIHWND", $Title)    # Win10/11 新版对话框
  if ($h1 -and $h1.ToInt64() -ne 0) { $handles += [IntPtr]$h1 }
  if ($h2 -and $h2.ToInt64() -ne 0) { $handles += [IntPtr]$h2 }
  $closed = 0
  foreach ($h in $handles) {
    $hw = [IntPtr]$h
    if (-not [FdClose]::IsWindow($hw)) { continue }
    [FdClose]::SetForegroundWindow($hw) | Out-Null
    Start-Sleep -Milliseconds 200
    # ESC 取消
    [FdClose]::PostMessage($hw, 0x0100, [IntPtr]0x1B, [IntPtr]0) | Out-Null
    [FdClose]::PostMessage($hw, 0x0101, [IntPtr]0x1B, [IntPtr]0) | Out-Null
    Start-Sleep -Milliseconds 300
    # 保险：WM_CLOSE
    [FdClose]::PostMessage($hw, 0x0010, [IntPtr]0, [IntPtr]0) | Out-Null
    $closed++
  }
  if ($closed -gt 0) { Write-Output "closed-file-dialog:$Title x$closed" }
  return $closed
}

if ($Loop) {
  while ($true) {
    $n = (Close-Dialog "打开") + (Close-Dialog "Open")
    Start-Sleep -Seconds 2
  }
} else {
  $n = (Close-Dialog "打开") + (Close-Dialog "Open")
  if ($n -eq 0) { Write-Output "no-file-dialog" }
}
