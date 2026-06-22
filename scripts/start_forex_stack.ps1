# Forex Scanner — tam stack baslat (proxy + watchdog + tarayici)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$LogDir = Join-Path $Root 'data'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

function Stop-PortListener([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Forex Scanner Stack" -ForegroundColor Cyan
Write-Host " Proje: $Root" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan

# Eski 8790 dinleyicisini kapat
Stop-PortListener 8790
Start-Sleep -Seconds 1

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "[HATA] Node.js bulunamadi. https://nodejs.org kurun." -ForegroundColor Red
  exit 1
}

$outLog = Join-Path $LogDir 'proxy_stdout.log'
$errLog = Join-Path $LogDir 'proxy_stderr.log'

Write-Host "[1/3] Proxy + watchdog baslatiliyor (port 8790)..." -ForegroundColor Yellow
Start-Process -FilePath $node `
  -ArgumentList 'proxy_watchdog.js' `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog | Out-Null

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $ping = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/ping' -TimeoutSec 2
    if ($ping.ok) { $ok = $true; break }
  } catch { }
}

if (-not $ok) {
  Write-Host "[HATA] Proxy ayaga kalkmadi. Log: $errLog" -ForegroundColor Red
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 }
  exit 2
}

Write-Host "[2/3] Proxy OK -> http://127.0.0.1:8790/" -ForegroundColor Green

try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/health' -TimeoutSec 35
  if ($health.mt5_ok -and $health.terminal_connected) {
    Write-Host "[3/3] MT5 OK - account $($health.account) ($($health.trade_mode))" -ForegroundColor Green
  } else {
    Write-Host "[3/3] MT5 UYARI - Lotas terminal acik ve login olmali" -ForegroundColor Yellow
  }
} catch {
  Write-Host "[3/3] MT5 health beklenmedik: $($_.Exception.Message)" -ForegroundColor Yellow
}

Start-Process 'http://127.0.0.1:8790/'
Write-Host "Tarayici acildi. Durdurmak icin: scripts\stop_forex_stack.ps1" -ForegroundColor Cyan
