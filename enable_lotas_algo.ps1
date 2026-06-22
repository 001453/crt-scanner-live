# Lotas MT5 algoritmik ticaret ac (.\enable_lotas_algo.ps1)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$py = Join-Path $PSScriptRoot 'runtime\python313\python.exe'
if (-not (Test-Path $py)) {
  $py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
}
if (-not (Test-Path $py)) { $py = 'python' }

Write-Host 'Lotas MT5 Algoritmik Ticaret aciliyor...' -ForegroundColor Cyan
Write-Host '(Lotas MT5 penceresi acik ve gorunur olmali)' -ForegroundColor Gray

& $py (Join-Path $PSScriptRoot 'scripts\enable_mt5_autotrading.py') --profile lotas
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'BASARISIZ — Lotas MT5 acik mi? Manuel: yesil Algoritmik Ticaret dugmesine tikla.' -ForegroundColor Red
  exit 1
}
Write-Host ''
Write-Host 'Tamam — Lotas algo trading acildi.' -ForegroundColor Green
