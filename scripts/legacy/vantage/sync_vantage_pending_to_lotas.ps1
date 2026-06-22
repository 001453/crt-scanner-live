# Vantage bekleyen emirleri Lotas'a kopyalar (tek seferlik). EURNZD blacklist'te atlanir.
$ErrorActionPreference = 'Continue'
$blocked = @('EURNZD', 'EURGBP')
$vantage = Invoke-RestMethod 'http://127.0.0.1:8791/api/trade-snapshot' -TimeoutSec 30
$lotas = Invoke-RestMethod 'http://127.0.0.1:8790/api/trade-snapshot' -TimeoutSec 30
$existing = @{}
foreach ($o in $lotas.pending_orders) { $existing["$($o.symbol)|$($o.side)"] = $true }
$results = @()
foreach ($o in $vantage.pending_orders) {
  $sym = ($o.symbol -replace '\.r$', '').ToUpper()
  $side = $o.side.ToUpper()
  if ($blocked -contains $sym) {
    $results += [pscustomobject]@{ symbol = $sym; side = $side; ok = $false; skip = 'blacklist' }
    continue
  }
  $key = "$sym|$side"
  if ($existing[$key]) {
    $results += [pscustomobject]@{ symbol = $sym; side = $side; ok = $true; skip = 'already_on_lotas' }
    continue
  }
  $body = @{
    symbol                 = $sym
    side                   = $side
    lot                    = 0.01
    sl                     = [double]$o.sl
    tp                     = [double]$o.tp
    placement              = 'pending'
    desired_entry          = [double]$o.price_open
    expire_min             = 1440
    dry_run                = $false
    target_account_type    = 'live'
    strategy_tag           = if ($o.strategy_tag) { $o.strategy_tag } else { 'core' }
    lock_sl_until_usd_tp   = $true
    tp_usd_target          = 2
    sl_usd_max             = 8
    allow_market_fallback  = $false
    auto_adjust_pending    = $true
  } | ConvertTo-Json -Compress
  try {
    $j = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/execute-order' -Method POST -ContentType 'application/json' -Body $body -TimeoutSec 90
    $results += [pscustomobject]@{ symbol = $sym; side = $side; ok = [bool]$j.ok; ticket = $j.ticket; error = $j.error; detail = $j.detail }
  }
  catch {
    $results += [pscustomobject]@{ symbol = $sym; side = $side; ok = $false; error = $_.Exception.Message }
  }
  Start-Sleep -Milliseconds 800
}
$results | Format-Table -AutoSize
