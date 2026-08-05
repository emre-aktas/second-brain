# Dev helper: capture the Second Brain window to a PNG so the rendered UI can be
# inspected without a human at the machine.
param(
    [string]$Out = "$env:TEMP\second-brain-shot.png",
    [string]$TitleMatch = "Second Brain",
    # Capture one specific process instead of searching by title.
    #
    # Worth having, and worth preferring: matching on title takes whichever window
    # the OS happens to list first, and with a second copy of the app already open —
    # a developer's own, pointed at their own notes — that is the wrong one. A
    # capture is data leaving the machine, so the caller should be able to say
    # exactly which window it came from.
    [int]$ProcessId = 0
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

if ($ProcessId -gt 0) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or -not $proc.MainWindowHandle -or $proc.MainWindowHandle -eq 0) {
        Write-Output "NO_WINDOW_FOR_PID"
        exit 1
    }
} else {
    $matches = @(Get-Process | Where-Object {
        $_.MainWindowTitle -and $_.MainWindowTitle -like "*$TitleMatch*"
    })

    if ($matches.Count -eq 0) {
        Write-Output "NO_WINDOW"
        exit 1
    }

    # Ambiguity is refused rather than guessed at. Silently picking one is how a
    # developer's own window, with their own notes in it, ends up in a screenshot.
    if ($matches.Count -gt 1) {
        Write-Output ("AMBIGUOUS: " + ($matches | ForEach-Object { $_.Id }) -join ',')
        Write-Output "Pass -ProcessId to choose one."
        exit 1
    }

    $proc = $matches[0]
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
