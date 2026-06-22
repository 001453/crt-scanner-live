# TrendGrid334 — MT5 Expert Advisor

Katı kurallı trend yönü grid EA. **$334 sermaye** / **EURUSD** için tasarlandı.

## Kurulum

1. `TrendGrid334.mq5` dosyasını MT5 veri klasörüne kopyalayın:
   ```
   File → Open Data Folder → MQL5 → Experts → TrendGrid334\
   ```
2. MetaEditor'de derleyin (F7).
3. EURUSD grafiğine sürükleyin.
4. **Algo Trading** açık olmalı (`enable_lotas_algo.bat`).

## Sabit kurallar (EA içinde kilitli)

| Kural | Değer |
|-------|--------|
| Lot | Her zaman **0.01** |
| Max seviye | **4** (trend yönünde) |
| Max toplam lot | **0.04** |
| EMA | 50 / 200 (Close) |
| ADX | 14, min **> 25** |
| Grid aralığı | **30 pip** (input, default) |
| Parçalı kapanış | +30p → %40, +55p → +%30, kalan %30 trail 20p |
| Max kâr bekleme | **+80 pip** → tamamını kapat |
| Trend kırılımı | 200 EMA ihlali → %100 kapat, yeni trend bekle |
| Floating zarar | **-$55** → acil kapat |
| Günlük zarar | **-$25** → gün boyu dur |
| Haber | Yüksek etki ±30 dk (EUR/USD takvim) |

## Input (sadece 2 ayar)

- **InpGridPips** — default 30
- **InpTrendTF** — default H1

## Notlar

- Bu EA, dashboard tarayıcı stratejilerinden (**LAT/ICT/Contrarian**) **bağımsızdır**.
- Dashboard'da **TrendGrid334 EA modu** açıkken EURUSD'ye otomatik emir gitmez (proxy guard).
- CRT `manage-positions` EA pozisyonlarına (magic **334001**, yorum **TG334**) dokunmaz.
- Haber filtresi MT5 **Economic Calendar** gerektirir (Tools → Options → Server → calendar).
- Strategy Tester'da calendar verisi sınırlı olabilir; canlıda test edin.
- Minimum lot 0.01 olduğu için %40/%30 kapanışlar en yakın 0.01 adıma yuvarlanır.

## Lotas kurulum (hızlı)

```powershell
cd D:\Projects\forex
.\scripts\install_trendgrid334_lotas.ps1
```

Dashboard: Plan → **TrendGrid334 EA modu** → Aç → **Ctrl+Shift+R**
