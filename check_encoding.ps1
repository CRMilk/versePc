$bytes = [System.IO.File]::ReadAllBytes('e:\Verse Explorer X\VersePC\css\style.css')
Write-Host "File size: $($bytes.Length) bytes"
$content = [System.Text.Encoding]::UTF8.GetString($bytes)
$marker1 = $content.IndexOf('.ai-subagent-card')
Write-Host "Index of .ai-subagent-card: $marker1"
$subagentComment = $content.IndexOf('Trae Solo')
Write-Host "Index of Trae Solo: $subagentComment"
$modelMarker = $content.IndexOf('.ai-model-popup')
Write-Host "Index of .ai-model-popup: $modelMarker"
