# Dev helper: type a prompt into the running app's composer and submit it, so the
# full agent -> tool -> Generated UI path can be exercised without a human at the
# keyboard.
param(
    [Parameter(Mandatory = $true)][string]$Text,
    [string]$TitleMatch = "Second Brain"
)

Add-Type -AssemblyName System.Windows.Forms

$signature = @'
using System;
using System.Runtime.InteropServices;

public class Driver {
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

if (-not ("Driver" -as [type])) { Add-Type -TypeDefinition $signature }

$proc = Get-Process | Where-Object {
    $_.MainWindowTitle -and $_.MainWindowTitle -like "*$TitleMatch*"
} | Select-Object -First 1

if (-not $proc) { Write-Output "NO_WINDOW"; exit 1 }

[Driver]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[Driver]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

$rect = New-Object Driver+RECT
[Driver]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

# The composer sits in the lower area of the right-hand panel.
$x = $rect.Left + [int]($width * 0.855)
$y = $rect.Top + [int]($height * 0.875)

[Driver]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[Driver]::mouse_event([Driver]::LEFTDOWN, 0, 0, 0, 0)
[Driver]::mouse_event([Driver]::LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500

# SendKeys treats these as control characters, so they must be escaped.
$escaped = $Text -replace '([+^%~(){}\[\]])', '{$1}'
[System.Windows.Forms.SendKeys]::SendWait($escaped)
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Write-Output "SENT at ${x},${y} :: $Text"
