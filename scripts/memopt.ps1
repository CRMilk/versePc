$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MemOpt {
    [DllImport("psapi.dll")]
    public static extern int EmptyWorkingSet(IntPtr hwProc);
}
"@

$before = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory

Get-Process | ForEach-Object {
    try {
        [void][MemOpt]::EmptyWorkingSet($_.Handle)
    } catch {}
}

Start-Sleep -Milliseconds 500
$after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
$diff = $after - $before
$result = @{ Before=$before; After=$after; Diff=$diff }
$result | ConvertTo-Json -Compress
