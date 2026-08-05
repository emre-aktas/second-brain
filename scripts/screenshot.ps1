# Dev helper: capture the Second Brain window to a PNG so the rendered UI can be
# inspected without a human at the machine.
param(
    [string]$Out = "$env:TEMP\second-brain-shot.png",
    [string]$TitleMatch = "Second Brain"
)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$signature = @'
using System;
using System.Runtime.InteropServices;

public class WinApi {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

if (-not ("WinApi" -as [type])) { Add-Type -TypeDefinition $signature }

$proc = Get-Process | Where-Object {
    $_.MainWindowTitle -and $_.MainWindowTitle -like "*$TitleMatch*"
} | Select-Object -First 1

if (-not $proc) {
    Write-Output "NO_WINDOW"
    exit 1
}

# SW_RESTORE, then raise, so a minimised window still captures.
[WinApi]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[WinApi]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

$rect = New-Object WinApi+RECT
[WinApi]::GetWindowRect($proc.MainWindowHandle, [ref]$rect) | Out-Null

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if ($width -le 0 -or $height -le 0) {
    Write-Output "BAD_RECT"
    exit 1
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "OK $Out ${width}x${height} pid=$($proc.Id) title=$($proc.MainWindowTitle)"
