[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$token = "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"
$headers = @{ Authorization = "token $token"; Accept = "application/vnd.github.v3+json"; "User-Agent" = "VersePC" }
$owner = "doujie081231"
$repo = "versePc"

function GhApi($method, $path, $body) {
    $uri = "https://api.github.com$path"
    for ($i = 0; $i -lt 3; $i++) {
        try {
            if ($body) {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
                $resp = Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -Body $bytes -ContentType "application/json; charset=utf-8" -TimeoutSec 60
            } else {
                $resp = Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -TimeoutSec 60
            }
            return $resp
        } catch {
            Write-Host "  Retry $($i+1): $($_.Exception.Message)"
            Start-Sleep -Seconds 3
        }
    }
    throw "Failed after 3 retries: $path"
}

Write-Host "Step 1: Getting latest commit..."
$ref = GhApi GET "/repos/$owner/$repo/git/refs/heads/main"
$latestSha = $ref.object.sha
Write-Host "  SHA: $latestSha"

$commit = GhApi GET "/repos/$owner/$repo/git/commits/$latestSha"
$baseTreeSha = $commit.tree.sha

$changed = (git diff --name-only HEAD~1) -split "`n" | Where-Object { $_ }
$allFiles = $changed | Select-Object -Unique
Write-Host "Step 2: Uploading $($allFiles.Count) files..."

$treeArr = @()
foreach ($f in $allFiles) {
    $fp = Join-Path $PWD.Path $f
    if (!(Test-Path $fp)) { Write-Host "  Skip: $f"; continue }
    $bytes = [System.IO.File]::ReadAllBytes($fp)
    $ext = [System.IO.Path]::GetExtension($f).ToLower()
    $textExts = @('.json','.js','.css','.html','.md','.nsh','.txt','.cjs','.ps1','.py','.xml','.svg')
    $isBin = -not ($textExts -contains $ext)

    if ($isBin) {
        $enc = [Convert]::ToBase64String($bytes)
        $bodyJson = '{"content":"' + $enc + '","encoding":"base64"}'
    } else {
        $enc = [System.IO.File]::ReadAllText($fp, [System.Text.Encoding]::UTF8)
        $escaped = $enc -replace '\\', '\\\\' -replace '"', '\"' -replace "`r", '\r' -replace "`n", '\n' -replace "`t", '\t'
        $bodyJson = '{"content":"' + $escaped + '","encoding":"utf-8"}'
    }
    $blob = GhApi POST "/repos/$owner/$repo/git/blobs" $bodyJson
    $normPath = $f -replace '\\', '/'
    $treeArr += '{"path":"' + $normPath + '","mode":"100644","type":"blob","sha":"' + $blob.sha + '"}'
    Write-Host "  $f -> $($blob.sha.Substring(0,8))"
}

Write-Host "Step 3: Creating tree..."
$treeJson = '{"base_tree":"' + $baseTreeSha + '","tree":[' + ($treeArr -join ',') + ']}'
$treeResult = GhApi POST "/repos/$owner/$repo/git/trees" $treeJson

Write-Host "Step 4: Creating commit..."
$commitMsg = "feat: AI resource install flow - version select card + download manager integration"
$commitJson = '{"message":"' + $commitMsg + '","tree":"' + $treeResult.sha + '","parents":["' + $latestSha + '"]}'
$newCommit = GhApi POST "/repos/$owner/$repo/git/commits" $commitJson

Write-Host "Step 5: Updating ref..."
$updateJson = '{"sha":"' + $newCommit.sha + '","force":false}'
$updated = GhApi PATCH "/repos/$owner/$repo/git/refs/heads/main" $updateJson
Write-Host "DONE! Pushed: $($updated.object.sha)"
