@echo off
chcp 65001 >nul
echo === GSAP Download Script ===
echo.

cd /d "%~dp0"

if not exist "js\gsap" mkdir "js\gsap"

echo Downloading GSAP from npmmirror...
powershell -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue'; " ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " ^
  "$url='https://registry.npmmirror.com/gsap/-/gsap-3.12.7.tgz'; " ^
  "$tgz='%TEMP%\gsap.tgz'; " ^
  "Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing -TimeoutSec 120; " ^
  "Write-Host ('Downloaded: ' + (Get-Item $tgz).Length + ' bytes'); " ^
  "tar -xf $tgz -C $env:TEMP; " ^
  "$dist=Join-Path $env:TEMP 'package\dist'; " ^
  "$files=@('gsap.min.js','ScrollTrigger.min.js','ScrollToPlugin.min.js','TextPlugin.min.js','Flip.min.js','Draggable.min.js','MotionPathPlugin.min.js','Observer.min.js'); " ^
  "foreach($f in $files){ " ^
  "  $src=Join-Path $dist $f; " ^
  "  $dst=Join-Path 'js\gsap' $f; " ^
  "  if(Test-Path $src){Copy-Item $src $dst -Force; Write-Host ('OK: ' + $f + ' (' + (Get-Item $dst).Length + ' bytes)')} " ^
  "  else{Write-Host ('SKIP: ' + $f)} " ^
  "}"

echo.
if exist "js\gsap\gsap.min.js" (
    echo === SUCCESS! GSAP installed to js\gsap\ ===
    dir "js\gsap" /b
) else (
    echo === FAILED! Please check network connection ===
)
echo.
pause
