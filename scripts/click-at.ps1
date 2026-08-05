# Dev helper: click a point inside the app window, given as a fraction of its size.
# Used to exercise UI paths without a human at the keyboard.
param(
    [Parameter(Mandatory = $true)][double]$FracX,
    [Parameter(Mandatory = $true)][double]$FracY,
    [string]$TitleMatch = "Second Brain"
)

$signature = @'
using System;
using System.Runtime.InteropServices;

public class Clicker {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);
    public const uint LEFTDOWN = 0x0002;
    public const uint LEFTUP = 0x0004;
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

if (-not ("Clicker" -as [type])) { Add-Type -TypeDefinition $signature }

$proc = Get-Process | Where-Object {
    $_.MainWindowTitle -and $_.MainWindowTitle -like "*$TitleMatch*"
} | Select-Object -First 1

if (-not $proc) { Write-Output "NO_WINDOW"; exit 1 }

[Clicker]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[Clicker]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 800

$rect = New-Object Clicker+RECT
[Clicker]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null

$x = $rect.Left + [int](($rect.Right - $rect.Left) * $FracX)
$y = $rect.Top + [int](($rect.Bottom - $rect.Top) * $FracY)

[Clicker]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 200
[Clicker]::mouse_event([Clicker]::LEFTDOWN, 0, 0, 0, 0)
[Clicker]::mouse_event([Clicker]::LEFTUP, 0, 0, 0, 0)

Write-Output "clicked $x,$y in $($proc.MainWindowTitle)"
