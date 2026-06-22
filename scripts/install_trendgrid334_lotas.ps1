# TrendGrid334 EA -> Lotas MT5 Experts klasorune kopyala
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$srcMq5 = Join-Path $root 'ea\TrendGrid334\TrendGrid334.mq5'
if (-not (Test-Path $srcMq5)) {
  Write-Host "Kaynak bulunamadi: $srcMq5" -ForegroundColor Red
  exit 1
}

$candidates = @(
  "$env:APPDATA\MetaQuotes\Terminal\*\MQL5\Experts",
  "$env:ProgramData\MetaQuotes\Terminal\*\MQL5\Experts"
)

$destRoots = @()
foreach ($pat in $candidates) {
  Get-Item -Path $pat -ErrorAction SilentlyContinue | ForEach-Object { $destRoots += $_.FullName }
}
$destRoots = $destRoots | Select-Object -Unique

if (-not $destRoots.Count) {
  Write-Host "MT5 Experts klasoru bulunamadi. MT5'i bir kez acip tekrar dene." -ForegroundColor Yellow
  Write-Host "Manuel: MetaEditor -> File -> Open Data Folder -> MQL5\Experts\TrendGrid334\" -ForegroundColor Yellow
  exit 1
}

foreach ($experts in $destRoots) {
  $destDir = Join-Path $experts 'TrendGrid334'
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Copy-Item -Path $srcMq5 -Destination (Join-Path $destDir 'TrendGrid334.mq5') -Force
  Write-Host "Kopyalandi: $(Join-Path $destDir 'TrendGrid334.mq5')" -ForegroundColor Green
}

Write-Host ""
Write-Host "Sonraki adimlar:" -ForegroundColor Cyan
Write-Host "  1. MetaEditor -> TrendGrid334.mq5 -> F7 (derle)"
Write-Host "  2. MT5 -> EURUSD H1 -> Navigator -> Expert Advisors -> TrendGrid334"
Write-Host "  3. Algo Trading acik (enable_lotas_algo.bat)"
Write-Host "  4. Dashboard -> Plan -> TrendGrid334 EA modu AC (EURUSD dashboard emirleri kapanir)"
Write-Host "  5. LAT/ICT diger paritelerde normal calisir"
