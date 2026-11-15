# Пересборка видео-демо сайта. Сайт должен работать на http://localhost:8765
# Нужны: Python + playwright (pip install playwright; python -m playwright install ffmpeg), FFmpeg (winget Gyan.FFmpeg), Microsoft Edge.
$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp  = Join-Path $env:TEMP 'sylva-video'
$fr   = Join-Path $tmp 'frames'
New-Item -ItemType Directory -Force $fr | Out-Null
Get-ChildItem $fr | Remove-Item -Force

# 1. Фон и рамка телефона (рамка — с прозрачным экраном)
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
foreach ($n in 'bg','frame') {
  Copy-Item (Join-Path $here "$n.html") (Join-Path $tmp "$n.html") -Force
  $url  = 'file:///' + ($tmp -replace '\\','/') + "/$n.html"
  $prof = Join-Path $env:TEMP ('edge-prof-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  $a = @('--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run',"--user-data-dir=$prof",'--window-size=1080,1920','--virtual-time-budget=6000','--allow-file-access-from-files',"--screenshot=$tmp\$n.png")
  if ($n -eq 'frame') { $a += '--default-background-color=00000000' }
  $a += $url
  Start-Process -FilePath $edge -ArgumentList $a -Wait -WindowStyle Hidden
}

# 2. Запись кадров сайта на «телефоне»
python (Join-Path $here 'record.py') $fr

# 3. Сборка MP4 1080×1920 (первые 2,45 с — белый кадр до открытия страницы, обрезаем)
$out = Join-Path (Split-Path -Parent $here) 'sylva-lodge-video.mp4'
Push-Location $fr
ffmpeg -v error -y -loop 1 -i "$tmp\bg.png" -f concat -safe 0 -i list.txt -i "$tmp\frame.png" -filter_complex "[1:v]fps=30,trim=start=2.45,setpts=PTS-STARTPTS,scale=700:1515:flags=lanczos,setsar=1[v];[0:v][v]overlay=190:300:shortest=1[a];[a][2:v]overlay=0:0,format=yuv420p[out]" -map "[out]" -c:v libx264 -preset slow -crf 19 -r 30 -movflags +faststart $out
Pop-Location
Write-Host "Готово: $out"
