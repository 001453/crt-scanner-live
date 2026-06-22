# TrendGrid334 EA -> Lotas MT5 EURUSD H1 grafigine otomatik tak
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$lotasTerm = 'D10A46355F54E5738D51DC3B97331AE4'
$termRoot = Join-Path $env:APPDATA "MetaQuotes\Terminal\$lotasTerm"
$eaDir = Join-Path $termRoot 'MQL5\Experts\TrendGrid334'
$metaEditor = 'C:\Program Files\Lotas Capital MT5 Terminal\MetaEditor64.exe'
$terminal = 'C:\Program Files\Lotas Capital MT5 Terminal\terminal64.exe'
$srcMq5 = Join-Path $root 'ea\TrendGrid334\TrendGrid334.mq5'

if (-not (Test-Path $srcMq5)) { throw "EA kaynak dosyasi yok: $srcMq5" }
if (-not (Test-Path $metaEditor)) { throw "MetaEditor bulunamadi: $metaEditor" }
if (-not (Test-Path $terminal)) { throw "Lotas terminal bulunamadi: $terminal" }

New-Item -ItemType Directory -Force -Path $eaDir | Out-Null
Copy-Item -Path $srcMq5 -Destination (Join-Path $eaDir 'TrendGrid334.mq5') -Force

Write-Host '[1/3] EA derleniyor (MetaEditor F7)...' -ForegroundColor Yellow
$mq5 = Join-Path $eaDir 'TrendGrid334.mq5'
$p = Start-Process -FilePath $metaEditor -ArgumentList @("/compile:$mq5", "/log") -PassThru -Wait
if ($p.ExitCode -ne 0) { Write-Host "MetaEditor exit=$($p.ExitCode)" -ForegroundColor DarkYellow }
Start-Sleep -Seconds 2
$ex5 = Join-Path $eaDir 'TrendGrid334.ex5'
if (-not (Test-Path $ex5)) {
  $log = Join-Path $eaDir 'TrendGrid334.log'
  if (Test-Path $log) { Get-Content $log -Tail 15 }
  throw 'Derleme basarisiz — TrendGrid334.ex5 olusmadi'
}
Write-Host "[OK] Derlendi: $ex5" -ForegroundColor Green

# Navigator'da kolay bulunsun diye kok Experts klasorune de kopyala
$expertsRoot = Join-Path $termRoot 'MQL5\Experts'
Copy-Item -Path $ex5 -Destination (Join-Path $expertsRoot 'TrendGrid334.ex5') -Force
Write-Host "[OK] Navigator icin kopyalandi: Experts\TrendGrid334.ex5" -ForegroundColor Green

$advisorsDir = Join-Path $expertsRoot 'Advisors'
Copy-Item -Path $ex5 -Destination (Join-Path $advisorsDir 'TrendGrid334.ex5') -Force
Copy-Item -Path $mq5 -Destination (Join-Path $advisorsDir 'TrendGrid334.mq5') -Force
Write-Host "[OK] Advisors klasorune kopyalandi (ExpertMACD yaninda gorunur)" -ForegroundColor Green

$iniPath = Join-Path $root 'data\mt5_attach_trendgrid334.ini'
@'
[StartUp]
Expert=Advisors\TrendGrid334
Symbol=EURUSD
Period=H1
'@ | Set-Content -Path $iniPath -Encoding ASCII

Write-Host '[2/3] Lotas MT5 aciliyor — EURUSD H1 + TrendGrid334 otomatik takilacak...' -ForegroundColor Yellow
Start-Process -FilePath $terminal -ArgumentList @("/config:$iniPath")

Start-Sleep -Seconds 8

Write-Host '[3/3] Tamam. Lotas penceresinde EURUSD grafigine bak:' -ForegroundColor Green
Write-Host '  - Sag ustte "TrendGrid334" yazmali' -ForegroundColor Green
Write-Host '  - Algo Trading yesil olmali' -ForegroundColor Green
Write-Host ''
Write-Host 'Dashboard (8790) diger pariteler icin LAT/ICT emir gondermeye devam eder.' -ForegroundColor Cyan
