$path = "E:\Verse Explorer X\VersePC\agent-engine.js"
$content = [System.IO.File]::ReadAllText($path)
$modified = $content.Replace("hostname: apiUrl.hostname,
        path: apiUrl.pathname", "hostname: apiUrl.hostname,
        port: apiUrl.port || undefined,
        path: apiUrl.pathname")
[System.IO.File]::WriteAllText($path, $modified)
Write-Output "DONE"
