//+------------------------------------------------------------------+
//| TrendGrid334.mq5 — Katı trend yönü grid EA ($334 sermaye)        |
//| Kurallar: 50/200 EMA + ADX(14)>25, max 4x0.01, parçalı kapanış   |
//+------------------------------------------------------------------+
#property copyright "forex project"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>
#include <Trade/OrderInfo.mqh>

//--- Sabit kurallar (değiştirilemez mantık; sadece grid pip default input)
input double   InpGridPips           = 30.0;    // Grid aralığı (pip) — default 30
input ENUM_TIMEFRAMES InpTrendTF     = PERIOD_H1; // Trend / EMA / ADX zaman dilimi
input ulong    InpMagic              = 334001;  // Magic number
input int      InpSlippagePoints     = 20;      // Slippage (point)

//--- Risk (katı sabitler — input yok)
#define FIXED_LOT              0.01
#define MAX_LEVELS             4
#define MAX_TOTAL_LOTS         0.04
#define EMA_FAST_PERIOD        50
#define EMA_SLOW_PERIOD        200
#define ADX_PERIOD             14
#define ADX_MIN                25.0
#define PROFIT_TIER1_PIPS      30.0
#define PROFIT_TIER2_PIPS      55.0
#define PROFIT_MAX_PIPS        80.0
#define PARTIAL_CLOSE_PCT1     0.40
#define PARTIAL_CLOSE_PCT2     0.30
#define TRAIL_PIPS             20.0
#define MAX_FLOATING_LOSS_USD  55.0
#define MAX_DAILY_LOSS_USD     25.0
#define NEWS_MINUTES_BEFORE    30
#define NEWS_MINUTES_AFTER     30

enum TrendState
  {
   TREND_NONE = 0,
   TREND_UP   = 1,
   TREND_DOWN = -1
  };

enum PartialStage
  {
   PARTIAL_NONE = 0,
   PARTIAL_T1   = 1,  // +30 pip: %40 kapandı
   PARTIAL_T2   = 2   // +55 pip: %30 daha kapandı → kalan %30 trail
  };

CTrade         g_trade;
CPositionInfo  g_pos;
COrderInfo     g_ord;

int            g_handleEma50  = INVALID_HANDLE;
int            g_handleEma200 = INVALID_HANDLE;
int            g_handleAdx    = INVALID_HANDLE;

TrendState     g_activeTrend      = TREND_NONE;
TrendState     g_lastBrokenTrend    = TREND_NONE;
bool           g_waitNewTrend       = false;
PartialStage   g_partialStage       = PARTIAL_NONE;
double         g_basketBaseVolume   = 0.0;
double         g_trailExtremePrice  = 0.0;
datetime       g_dailyAnchor        = 0;
double         g_dailyClosedPnl     = 0.0;
bool           g_dailyHalt          = false;
datetime       g_lastBarTime        = 0;

//+------------------------------------------------------------------+
double PipSize()
  {
   const int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(digits == 3 || digits == 5)
      return point * 10.0;
   return point;
  }

//+------------------------------------------------------------------+
double NormalizeVolume(double volume)
  {
   const double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   const double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   const double vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   if(step <= 0.0)
      return volume;
   double v = MathFloor(volume / step + 1e-8) * step;
   v = MathMax(vmin, MathMin(vmax, v));
   return NormalizeDouble(v, 2);
  }

//+------------------------------------------------------------------+
bool ReadIndicators(double &ema50, double &ema200, double &adx, double &closePrice)
  {
   double bufEma50[1], bufEma200[1], bufAdx[1], bufClose[1];
   if(CopyBuffer(g_handleEma50, 0, 1, 1, bufEma50) != 1)
      return false;
   if(CopyBuffer(g_handleEma200, 0, 1, 1, bufEma200) != 1)
      return false;
   if(CopyBuffer(g_handleAdx, 0, 1, 1, bufAdx) != 1)
      return false;
   if(CopyClose(_Symbol, InpTrendTF, 1, 1, bufClose) != 1)
      return false;
   ema50 = bufEma50[0];
   ema200 = bufEma200[0];
   adx = bufAdx[0];
   closePrice = bufClose[0];
   return (ema50 > 0.0 && ema200 > 0.0 && adx >= 0.0);
  }

//+------------------------------------------------------------------+
TrendState DetectTrend(const double ema50, const double ema200, const double adx, const double closePrice)
  {
   if(adx <= ADX_MIN)
      return TREND_NONE;
   if(closePrice > ema200 && ema50 > ema200)
      return TREND_UP;
   if(closePrice < ema200 && ema50 < ema200)
      return TREND_DOWN;
   return TREND_NONE;
  }

//+------------------------------------------------------------------+
bool IsOurPosition()
  {
   return (g_pos.Symbol() == _Symbol && g_pos.Magic() == InpMagic);
  }

bool IsOurOrder()
  {
   return (g_ord.Symbol() == _Symbol && g_ord.Magic() == InpMagic);
  }

//+------------------------------------------------------------------+
int CountOpenPositions()
  {
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(IsOurPosition())
         count++;
     }
   return count;
  }

//+------------------------------------------------------------------+
double TotalOpenVolume()
  {
   double vol = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(IsOurPosition())
         vol += g_pos.Volume();
     }
   return vol;
  }

//+------------------------------------------------------------------+
double BasketFloatingPnlUsd()
  {
   double pnl = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(IsOurPosition())
         pnl += g_pos.Profit() + g_pos.Swap() + g_pos.Commission();
     }
   return pnl;
  }

//+------------------------------------------------------------------+
double WeightedAvgEntry(const ENUM_POSITION_TYPE typeFilter)
  {
   double sumPxVol = 0.0;
   double sumVol = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(!IsOurPosition())
         continue;
      if(g_pos.PositionType() != typeFilter)
         continue;
      const double v = g_pos.Volume();
      sumPxVol += g_pos.PriceOpen() * v;
      sumVol += v;
     }
   if(sumVol <= 0.0)
      return 0.0;
   return sumPxVol / sumVol;
  }

//+------------------------------------------------------------------+
double BasketProfitPips(const TrendState trend)
  {
   if(trend == TREND_NONE)
      return 0.0;
   const double pip = PipSize();
   if(pip <= 0.0)
      return 0.0;

   if(trend == TREND_UP)
     {
      const double avg = WeightedAvgEntry(POSITION_TYPE_BUY);
      if(avg <= 0.0)
         return 0.0;
      return (SymbolInfoDouble(_Symbol, SYMBOL_BID) - avg) / pip;
     }

   const double avg = WeightedAvgEntry(POSITION_TYPE_SELL);
   if(avg <= 0.0)
      return 0.0;
   return (avg - SymbolInfoDouble(_Symbol, SYMBOL_ASK)) / pip;
  }

//+------------------------------------------------------------------+
void CancelAllPending()
  {
   for(int i = OrdersTotal() - 1; i >= 0; --i)
     {
      if(!g_ord.SelectByIndex(i))
         continue;
      if(!IsOurOrder())
         continue;
      g_trade.OrderDelete(g_ord.Ticket());
     }
  }

//+------------------------------------------------------------------+
void CloseAllPositions(const string reason)
  {
   CancelAllPending();
   for(int pass = 0; pass < 3; ++pass)
     {
      bool any = false;
      for(int i = PositionsTotal() - 1; i >= 0; --i)
        {
         if(!g_pos.SelectByIndex(i))
            continue;
         if(!IsOurPosition())
            continue;
         any = true;
         g_trade.PositionClose(g_pos.Ticket());
        }
      if(!any)
         break;
     }
   g_partialStage = PARTIAL_NONE;
   g_basketBaseVolume = 0.0;
   g_trailExtremePrice = 0.0;
   Print("TrendGrid334: tüm pozisyonlar kapandı — ", reason);
  }

//+------------------------------------------------------------------+
bool CloseVolumeAmount(const double targetVolume)
  {
   if(targetVolume <= 0.0)
      return true;

   double remaining = NormalizeVolume(targetVolume);
   if(remaining <= 0.0)
      return true;

   // En eski pozisyonlardan başla
   struct PosRow { ulong ticket; datetime t; double vol; };
   PosRow rows[];
   ArrayResize(rows, 0);

   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(!IsOurPosition())
         continue;
      PosRow row;
      row.ticket = g_pos.Ticket();
      row.t = (datetime)g_pos.Time();
      row.vol = g_pos.Volume();
      const int n = ArraySize(rows);
      ArrayResize(rows, n + 1);
      rows[n] = row;
     }

   // Basit sıralama (eski → yeni)
   for(int a = 0; a < ArraySize(rows) - 1; ++a)
     {
      for(int b = a + 1; b < ArraySize(rows); ++b)
        {
         if(rows[b].t < rows[a].t)
           {
            PosRow tmp = rows[a];
            rows[a] = rows[b];
            rows[b] = tmp;
           }
        }
     }

   for(int i = 0; i < ArraySize(rows) && remaining > 0.0; ++i)
     {
      if(!g_pos.SelectByTicket(rows[i].ticket))
         continue;
      const double posVol = g_pos.Volume();
      if(posVol <= remaining + 1e-8)
        {
         if(!g_trade.PositionClose(rows[i].ticket))
            return false;
         remaining -= posVol;
        }
      else
        {
         const double closeVol = NormalizeVolume(remaining);
         if(closeVol <= 0.0)
            break;
         if(!g_trade.PositionClosePartial(rows[i].ticket, closeVol))
           {
            // Partial desteklenmiyorsa tam pozisyon kapat
            if(!g_trade.PositionClose(rows[i].ticket))
               return false;
           }
         remaining = 0.0;
        }
     }
   return remaining <= 1e-8;
  }

//+------------------------------------------------------------------+
bool CurrencyMatchesSymbol(const string currency)
  {
   if(StringLen(currency) == 0)
      return false;
   return (StringFind(_Symbol, currency) >= 0);
  }

//+------------------------------------------------------------------+
bool IsHighImpactNewsBlackout()
  {
   datetime now = TimeCurrent();
   datetime from = now - NEWS_MINUTES_BEFORE * 60;
   datetime to   = now + NEWS_MINUTES_AFTER * 60;

   MqlCalendarValue values[];
   string currencies[2] = {"EUR", "USD"};
   for(int c = 0; c < 2; ++c)
     {
      if(!CurrencyMatchesSymbol(currencies[c]))
         continue;
      ArrayResize(values, 0);
      if(!CalendarValueHistory(values, from, to, NULL, currencies[c]))
         continue;
      for(int i = 0; i < ArraySize(values); ++i)
        {
         if(values[i].impact_type != CALENDAR_IMPACT_HIGH)
            continue;
         datetime eventTime = values[i].time;
         if(eventTime <= 0)
            continue;
         if(now >= eventTime - NEWS_MINUTES_BEFORE * 60 &&
            now <= eventTime + NEWS_MINUTES_AFTER * 60)
            return true;
        }
     }
   return false;
  }

//+------------------------------------------------------------------+
void ResetDailyIfNeeded()
  {
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   dt.hour = 0;
   dt.min = 0;
   dt.sec = 0;
   const datetime dayStart = StructToTime(dt);
   if(g_dailyAnchor != dayStart)
     {
      g_dailyAnchor = dayStart;
      g_dailyClosedPnl = 0.0;
      g_dailyHalt = false;
     }
  }

//+------------------------------------------------------------------+
void UpdateDailyClosedPnl()
  {
   if(!HistorySelect(g_dailyAnchor, TimeCurrent()))
      return;
   double pnl = 0.0;
   const int total = HistoryDealsTotal();
   for(int i = 0; i < total; ++i)
     {
      const ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0)
         continue;
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != _Symbol)
         continue;
      if((ulong)HistoryDealGetInteger(ticket, DEAL_MAGIC) != InpMagic)
         continue;
      if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT)
         continue;
      pnl += HistoryDealGetDouble(ticket, DEAL_PROFIT)
           + HistoryDealGetDouble(ticket, DEAL_SWAP)
           + HistoryDealGetDouble(ticket, DEAL_COMMISSION);
     }
   g_dailyClosedPnl = pnl;
   if(g_dailyClosedPnl <= -MAX_DAILY_LOSS_USD)
      g_dailyHalt = true;
  }

//+------------------------------------------------------------------+
bool TrendBreakTriggered(const TrendState trend, const double ema200)
  {
   if(trend == TREND_UP)
      return (SymbolInfoDouble(_Symbol, SYMBOL_BID) < ema200);
   if(trend == TREND_DOWN)
      return (SymbolInfoDouble(_Symbol, SYMBOL_ASK) > ema200);
   return false;
  }

//+------------------------------------------------------------------+
bool OpenMarketEntry(const TrendState trend)
  {
   if(CountOpenPositions() > 0)
      return true;

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);

   bool ok = false;
   if(trend == TREND_UP)
      ok = g_trade.Buy(FIXED_LOT, _Symbol, 0.0, 0.0, 0.0, "TG334 L0 BUY");
   else if(trend == TREND_DOWN)
      ok = g_trade.Sell(FIXED_LOT, _Symbol, 0.0, 0.0, 0.0, "TG334 L0 SELL");

   if(ok)
     {
      g_partialStage = PARTIAL_NONE;
      g_basketBaseVolume = FIXED_LOT;
      g_trailExtremePrice = 0.0;
     }
   return ok;
  }

//+------------------------------------------------------------------+
double GridPriceForLevel(const TrendState trend, const double anchorPrice, const int level)
  {
   const double pip = PipSize();
   const double dist = InpGridPips * pip * level;
   if(trend == TREND_UP)
      return NormalizeDouble(anchorPrice - dist, (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS));
   return NormalizeDouble(anchorPrice + dist, (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS));
  }

//+------------------------------------------------------------------+
double FirstEntryPrice(const TrendState trend)
  {
   datetime oldest = LONG_MAX;
   double price = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(!IsOurPosition())
         continue;
      if(trend == TREND_UP && g_pos.PositionType() != POSITION_TYPE_BUY)
         continue;
      if(trend == TREND_DOWN && g_pos.PositionType() != POSITION_TYPE_SELL)
         continue;
      const datetime t = (datetime)g_pos.Time();
      if(t <= oldest)
        {
         oldest = t;
         price = g_pos.PriceOpen();
        }
     }
   return price;
  }

//+------------------------------------------------------------------+
bool PendingExistsAtPrice(const double price, const ENUM_ORDER_TYPE type)
  {
   const double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   for(int i = OrdersTotal() - 1; i >= 0; --i)
     {
      if(!g_ord.SelectByIndex(i))
         continue;
      if(!IsOurOrder())
         continue;
      if(g_ord.OrderType() != type)
         continue;
      if(MathAbs(g_ord.PriceOpen() - price) <= point)
         return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
bool PositionExistsNearGrid(const TrendState trend, const double anchor, const int level)
  {
   const double px = GridPriceForLevel(trend, anchor, level);
   const double tol = SymbolInfoDouble(_Symbol, SYMBOL_POINT) * 2.0;
   for(int i = PositionsTotal() - 1; i >= 0; --i)
     {
      if(!g_pos.SelectByIndex(i))
         continue;
      if(!IsOurPosition())
         continue;
      if(MathAbs(g_pos.PriceOpen() - px) <= tol)
         return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
void ManageGridLimits(const TrendState trend)
  {
   int openCount = CountOpenPositions();
   int pendingCount = CountPendingOrders();
   if(openCount + pendingCount >= MAX_LEVELS)
      return;

   const double anchor = FirstEntryPrice(trend);
   if(anchor <= 0.0)
      return;

   for(int level = 1; level < MAX_LEVELS; ++level)
     {
      if(openCount + pendingCount >= MAX_LEVELS)
         break;
      if(PositionExistsNearGrid(trend, anchor, level))
         continue;

      const double px = GridPriceForLevel(trend, anchor, level);
      bool placed = false;
      if(trend == TREND_UP)
        {
         if(PendingExistsAtPrice(px, ORDER_TYPE_BUY_LIMIT))
            continue;
         placed = g_trade.BuyLimit(FIXED_LOT, px, _Symbol, 0.0, 0.0, ORDER_TIME_GTC, 0, "TG334 L" + IntegerToString(level) + " BUY");
        }
      else
        {
         if(PendingExistsAtPrice(px, ORDER_TYPE_SELL_LIMIT))
            continue;
         placed = g_trade.SellLimit(FIXED_LOT, px, _Symbol, 0.0, 0.0, ORDER_TIME_GTC, 0, "TG334 L" + IntegerToString(level) + " SELL");
        }
      if(placed)
         pendingCount++;
     }
  }

//+------------------------------------------------------------------+
int CountPendingOrders()
  {
   int count = 0;
   for(int i = OrdersTotal() - 1; i >= 0; --i)
     {
      if(!g_ord.SelectByIndex(i))
         continue;
      if(IsOurOrder())
         count++;
     }
   return count;
  }

//+------------------------------------------------------------------+
void ManagePartialCloses(const TrendState trend)
  {
   const int openCount = CountOpenPositions();
   if(openCount <= 0)
     {
      g_partialStage = PARTIAL_NONE;
      g_basketBaseVolume = 0.0;
      return;
     }

   const double profitPips = BasketProfitPips(trend);
   if(profitPips >= PROFIT_MAX_PIPS)
     {
      CloseAllPositions("max +80 pip kuralı");
      g_activeTrend = TREND_NONE;
      return;
     }

   double totalVol = TotalOpenVolume();
   if(g_basketBaseVolume <= 0.0)
      g_basketBaseVolume = totalVol;

   if(g_partialStage == PARTIAL_NONE && profitPips >= PROFIT_TIER1_PIPS)
     {
      const double closeVol = NormalizeVolume(g_basketBaseVolume * PARTIAL_CLOSE_PCT1);
      if(CloseVolumeAmount(closeVol))
         g_partialStage = PARTIAL_T1;
     }
   else if(g_partialStage == PARTIAL_T1 && profitPips >= PROFIT_TIER2_PIPS)
     {
      const double closeVol = NormalizeVolume(g_basketBaseVolume * PARTIAL_CLOSE_PCT2);
      if(CloseVolumeAmount(closeVol))
        {
         g_partialStage = PARTIAL_T2;
         if(trend == TREND_UP)
            g_trailExtremePrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         else
            g_trailExtremePrice = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
        }
     }
  }

//+------------------------------------------------------------------+
void ManageTrailingStop(const TrendState trend)
  {
   if(g_partialStage != PARTIAL_T2)
      return;
   if(CountOpenPositions() <= 0)
      return;

   const double pip = PipSize();
   const double trailDist = TRAIL_PIPS * pip;

   if(trend == TREND_UP)
     {
      const double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      if(g_trailExtremePrice <= 0.0 || bid > g_trailExtremePrice)
         g_trailExtremePrice = bid;
      if(bid <= g_trailExtremePrice - trailDist)
         CloseAllPositions("trailing stop 20 pip (BUY)");
     }
   else if(trend == TREND_DOWN)
     {
      const double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      if(g_trailExtremePrice <= 0.0 || ask < g_trailExtremePrice)
         g_trailExtremePrice = ask;
      if(ask >= g_trailExtremePrice + trailDist)
         CloseAllPositions("trailing stop 20 pip (SELL)");
     }
  }

//+------------------------------------------------------------------+
bool IsNewBar()
  {
   datetime t = iTime(_Symbol, InpTrendTF, 0);
   if(t == 0)
      return false;
   if(t != g_lastBarTime)
     {
      g_lastBarTime = t;
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(_Symbol != "EURUSD")
      Print("TrendGrid334 UYARI: EA EURUSD için tasarlandı. Sembol=", _Symbol);

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   g_trade.SetTypeFillingBySymbol(_Symbol);

   g_handleEma50  = iMA(_Symbol, InpTrendTF, EMA_FAST_PERIOD, 0, MODE_EMA, PRICE_CLOSE);
   g_handleEma200 = iMA(_Symbol, InpTrendTF, EMA_SLOW_PERIOD, 0, MODE_EMA, PRICE_CLOSE);
   g_handleAdx    = iADX(_Symbol, InpTrendTF, ADX_PERIOD);

   if(g_handleEma50 == INVALID_HANDLE || g_handleEma200 == INVALID_HANDLE || g_handleAdx == INVALID_HANDLE)
     {
      Print("TrendGrid334: indikatör handle oluşturulamadı");
      return INIT_FAILED;
     }

   ResetDailyIfNeeded();
   g_lastBarTime = iTime(_Symbol, InpTrendTF, 0);
   return INIT_SUCCEEDED;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   if(g_handleEma50  != INVALID_HANDLE) IndicatorRelease(g_handleEma50);
   if(g_handleEma200 != INVALID_HANDLE) IndicatorRelease(g_handleEma200);
   if(g_handleAdx    != INVALID_HANDLE) IndicatorRelease(g_handleAdx);
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   ResetDailyIfNeeded();
   UpdateDailyClosedPnl();

   //--- Risk: günlük zarar
   if(g_dailyHalt || g_dailyClosedPnl <= -MAX_DAILY_LOSS_USD)
     {
      if(CountOpenPositions() > 0 || CountPendingOrders() > 0)
         CloseAllPositions("günlük max zarar $25");
      return;
     }

   //--- Risk: floating zarar
   if(BasketFloatingPnlUsd() <= -MAX_FLOATING_LOSS_USD)
     {
      CloseAllPositions("floating zarar $55 aşıldı");
      g_waitNewTrend = true;
      g_activeTrend = TREND_NONE;
      return;
     }

   //--- Haber filtresi
   if(IsHighImpactNewsBlackout())
     {
      CancelAllPending();
      return;
     }

   double ema50, ema200, adx, closePrice;
   if(!ReadIndicators(ema50, ema200, adx, closePrice))
      return;

   const TrendState detected = DetectTrend(ema50, ema200, adx, closePrice);

   //--- Trend kırılımı (200 EMA) — tick bazlı zorunlu çıkış
   if(g_activeTrend != TREND_NONE && TrendBreakTriggered(g_activeTrend, ema200))
     {
      g_lastBrokenTrend = g_activeTrend;
      g_waitNewTrend = true;
      g_activeTrend = TREND_NONE;
      CloseAllPositions("200 EMA trend kırılımı");
      return;
     }

   //--- ADX düşük / trend yok → grid yok
   if(detected == TREND_NONE)
     {
      if(CountOpenPositions() == 0)
        {
         CancelAllPending();
         g_activeTrend = TREND_NONE;
        }
      else
        {
         ManagePartialCloses(g_activeTrend);
         ManageTrailingStop(g_activeTrend);
        }
      return;
     }

   //--- Kırılım sonrası yeni trend bekle
   if(g_waitNewTrend)
     {
      if(IsNewBar())
        {
         // Yeni trend teyidi: ADX>25 + tam uptrend/downtrend
         g_waitNewTrend = false;
         g_lastBrokenTrend = TREND_NONE;
         g_activeTrend = detected;
        }
      else
        {
         CancelAllPending();
         return;
        }
     }

   //--- Yeni trend oturumu
   if(g_activeTrend == TREND_NONE && CountOpenPositions() == 0)
      g_activeTrend = detected;

   if(g_activeTrend != detected && CountOpenPositions() == 0 && CountPendingOrders() == 0)
      g_activeTrend = detected;

   //--- Aktif trend yönü değiştiyse (açık pozisyon yokken) güncelle
   if(CountOpenPositions() == 0 && CountPendingOrders() == 0)
      g_activeTrend = detected;

   if(g_activeTrend == TREND_NONE)
      return;

   //--- Parçalı kapanış + trailing + max pip
   ManagePartialCloses(g_activeTrend);
   ManageTrailingStop(g_activeTrend);

   if(CountOpenPositions() == 0 && g_partialStage == PARTIAL_NONE)
     {
      // Yeni grid döngüsü — sadece yeni bar'da ilk market girişi
      if(IsNewBar())
         OpenMarketEntry(g_activeTrend);
     }

   //--- Grid limit emirleri
   ManageGridLimits(g_activeTrend);

   //--- Max lot güvenlik
   if(TotalOpenVolume() > MAX_TOTAL_LOTS + 1e-8)
      Print("TrendGrid334 UYARI: toplam lot ", TotalOpenVolume(), " > ", MAX_TOTAL_LOTS);
  }
//+------------------------------------------------------------------+
