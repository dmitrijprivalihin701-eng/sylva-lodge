# Ролик о приложении онлайн-брони (для отправки клиентам).
# Нужны: Python + playwright, FFmpeg, Microsoft Edge. Интернет (открывается опубликованное приложение).
param([switch]$SkipRecord)
$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp   = Join-Path $env:TEMP 'sylva-appvideo'
$fr    = Join-Path $tmp 'frames'
New-Item -ItemType Directory -Force $fr | Out-Null

# 1. Запись: приложение → чат с ботом → таблица
if (-not $SkipRecord) { Get-ChildItem $fr | Remove-Item -Force; python (Join-Path $here 'record.py') $fr }
$m = Get-Content (Join-Path $fr 'markers.json') -Raw -Encoding utf8 | ConvertFrom-Json
$S = [math]::Max(0, $m.markers.c1 - 0.6)
$keys = @('c1','c2','c3','c4','c5','c6','c7','c8')
$t = @{}; foreach ($k in $keys) { $t[$k] = [math]::Round($m.markers.$k - $S, 2) }
$len = [math]::Round($m.end - $S, 2)

# 2. Фон, рамка телефона, заставка, финал, подписи к шагам
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
Copy-Item (Join-Path $here 'cards.html') (Join-Path $tmp 'cards.html') -Force
Copy-Item (Join-Path $here '..\video\frame.html') (Join-Path $tmp 'frame.html') -Force
function Render($page, $hash, $png, $transparent) {
  $url  = 'file:///' + ($tmp -replace '\\','/') + "/$page" + $(if ($hash) { '#' + [uri]::EscapeDataString($hash) } else { '' })
  $prof = Join-Path $env:TEMP ('edge-prof-' + [guid]::NewGuid().ToString('N').Substring(0,6))
  $a = @('--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run',"--user-data-dir=$prof",'--window-size=1080,1920','--virtual-time-budget=6000','--allow-file-access-from-files',"--screenshot=$png")
  if ($transparent) { $a += '--default-background-color=00000000' }
  Start-Process -FilePath $edge -ArgumentList ($a + $url) -Wait -WindowStyle Hidden
}
Render 'cards.html' 'bg'    "$tmp\bg.png"    $false
Render 'cards.html' 'title' "$tmp\title.png" $false
Render 'cards.html' 'end'   "$tmp\end.png"   $false
Render 'frame.html' ''      "$tmp\frame.png" $true
$caps = [ordered]@{
  c1='1:Гость выбирает домик'; c2='2:Даты и гости — занятые дни видно сразу'; c3='3:Добавляет баню, чан и завтрак';
  c4='4:Видит итог и предоплату 30%'; c5='5:Оплачивает картой или через СБП'; c6='6:Бронь подтверждена, даты закрыты для других';
  c7='7:Вам сразу приходит уведомление в Telegram'; c8='8:И бронь сохраняется в таблице' }
foreach ($k in $keys) { Render 'cards.html' ("cap:" + $caps[$k]) "$tmp\$k.png" $true }

# 3. Основная часть: фон + запись в рамке телефона + подписи по шагам
$inputs = @('-loop','1','-i',"$tmp\bg.png",'-f','concat','-safe','0','-i','list.txt','-i',"$tmp\frame.png")
foreach ($k in $keys) { $inputs += @('-loop','1','-i',"$tmp\$k.png") }
$f = "[1:v]fps=30,trim=start=$S,setpts=PTS-STARTPTS,scale=700:1515:flags=lanczos,setsar=1[v];[0:v][v]overlay=190:300:shortest=1[a0];[a0][2:v]overlay=0:0[b0]"
for ($i = 0; $i -lt $keys.Count; $i++) {
  $from = $t[$keys[$i]]; $to = $(if ($i + 1 -lt $keys.Count) { $t[$keys[$i+1]] } else { $len + 1 })
  $f += ";[$($i+3):v]format=rgba,fade=t=in:st=$($from):d=0.35:alpha=1[k$i];[b$i][k$i]overlay=0:0:enable='between(t,$from,$to)':shortest=1[b$($i+1)]"
}
$f += ";[b$($keys.Count)]format=yuv420p[out]"
Push-Location $fr
ffmpeg -v error -y @inputs -filter_complex $f -map '[out]' -t $len -c:v libx264 -preset slow -crf 19 -r 30 "$tmp\main.mp4"
Pop-Location

# 4. Заставка (3 с) + основная часть + финал (4 с), мягкие переходы
$out = Join-Path (Split-Path -Parent $here) 'sylva-lodge-app.mp4'
$mainLen = [double](ffprobe -v error -show_entries format=duration -of csv=p=0 "$tmp\main.mp4")
$off2 = [math]::Round(2.5 + $mainLen - 0.6, 2)
ffmpeg -v error -y -loop 1 -t 3 -i "$tmp\title.png" -i "$tmp\main.mp4" -loop 1 -t 4 -i "$tmp\end.png" -filter_complex `
  "[0:v]fps=30,format=yuv420p,setsar=1[t];[1:v]fps=30,format=yuv420p,setsar=1[m];[2:v]fps=30,format=yuv420p,setsar=1[e];[t][m]xfade=transition=fade:duration=0.5:offset=2.5[tm];[tm][e]xfade=transition=fade:duration=0.6:offset=$off2[out]" `
  -map '[out]' -c:v libx264 -preset slow -crf 19 -r 30 -movflags +faststart $out
Write-Host "Готово: $out"
