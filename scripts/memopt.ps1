$ErrorActionPreference = 'Continue'
$before = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
try {
    $proc = [System.Diagnostics.Process]::GetCurrentProcess()
    $proc.MinWorkingSet = [IntPtr](-1)
    $proc.MaxWorkingSet = [IntPtr](-1)
} catch {}
Get-Process | ForEach-Object {
    try {
        $_.MinWorkingSet = [IntPtr](-1)
        $_.MaxWorkingSet = [IntPtr](-1)
    } catch {}
}
Start-Sleep -Milliseconds 500
$after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
$diff = $after - $before
$result = @{ Before=$before; After=$after; Diff=$diff }
$result | ConvertTo-Json -Compress
