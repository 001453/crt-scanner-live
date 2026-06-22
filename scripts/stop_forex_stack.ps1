# Forex Scanner — proxy durdur (8790)
$Port = 8790
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host "Durduruluyor PID $($_.OwningProcess) (port $Port)"
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
  }
Write-Host "Forex proxy durduruldu."
