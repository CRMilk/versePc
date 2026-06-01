$cssPath = 'e:\Verse Explorer X\VersePC\css\style.css'
$newCssPath = 'e:\Verse Explorer X\VersePC\new_subagent_css.txt'

$bytes = [System.IO.File]::ReadAllBytes($cssPath)
$content = [System.Text.Encoding]::UTF8.GetString($bytes)

$newCss = [System.IO.File]::ReadAllText($newCssPath, [System.Text.Encoding]::UTF8)

$startMarker = '.ai-subagent-card {'
$startIdx = $content.IndexOf($startMarker)
if ($startIdx -lt 0) {
    Write-Host "ERROR: Could not find start marker"
    exit 1
}

$commentStart = $content.LastIndexOf('/*', $startIdx)
if ($commentStart -ge 0 -and ($startIdx - $commentStart) -lt 200) {
    $startIdx = $commentStart
}
Write-Host "Start index: $startIdx"

$endMarker = '.ai-model-popup'
$endIdx = $content.IndexOf($endMarker, $startIdx)
if ($endIdx -lt 0) {
    Write-Host "ERROR: Could not find end marker"
    exit 1
}

$lineStart = $content.LastIndexOf("`n", $endIdx)
if ($lineStart -ge 0 -and ($endIdx - $lineStart) -lt 200) {
    $endIdx = $lineStart + 1
}
Write-Host "End index: $endIdx"

$before = $content.Substring(0, $startIdx)
$after = $content.Substring($endIdx)

$newContent = $before + $newCss + $after

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cssPath, $newContent, $utf8NoBom)

$finalBytes = [System.IO.File]::ReadAllBytes($cssPath)
Write-Host "Done! New file size: $($finalBytes.Length) bytes"
