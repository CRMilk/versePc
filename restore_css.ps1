$gitExe = "git"
$tempFile = [System.IO.Path]::GetTempFileName()
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $gitExe
$psi.Arguments = "show 8ed6baf`:css/style.css"
$psi.RedirectStandardOutput = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$gitOutput = $proc.StandardOutput.ReadToEnd()
$proc.WaitForExit()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($gitOutput)
[System.IO.File]::WriteAllBytes('e:\Verse Explorer X\VersePC\css\style.css', $bytes)
Write-Host "Restored file, size: $($bytes.Length) bytes"
