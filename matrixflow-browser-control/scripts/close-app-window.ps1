param(
  [string]$Title = "MatrixFlow",
  [switch]$List
)
# 关闭指定标题的窗口（用于右上角关闭按钮消失时兜底，等效于 Alt+F4）
# 用法: powershell -File close-app-window.ps1                       # 关闭 MatrixFlow 主窗口
#       powershell -File close-app-window.ps1 -Title "脸书4"        # 按标题关
#       powershell -File close-app-window.ps1 -List                 # 列出所有可见窗口
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CwUtil {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@

$found = New-Object System.Collections.ArrayList
$cb = [CwUtil+EnumWindowsProc]{
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [CwUtil]::GetWindowText($h, $sb, 256) | Out-Null
  $t = $sb.ToString()
  if ($t -and [CwUtil]::IsWindowVisible($h)) {
    [void]$found.Add([PSCustomObject]@{ Handle = $h; Title = $t })
  }
  return $true
}
[CwUtil]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($List) {
  $found | Format-Table Handle, Title -AutoSize
  exit 0
}

$targets = $found | Where-Object { $_.Title -like "*$Title*" }
if (-not $targets) { Write-Output "no-window-matched:$Title"; exit 1 }
$closed = 0
foreach ($t in $targets) {
  # WM_CLOSE (0x0010) —— 等效于点击关闭按钮
  [CwUtil]::PostMessage($t.Handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Write-Output "closed:$($t.Title)"
  $closed++
}
Write-Output "done:$closed"
