# Vantage mirror (opsiyonel)

Varsayilan kurulum **sadece Lotas** kullanir. Vantage ikinci hesap mirror'u kapali.

Bu klasordeki dosyalar yalnizca mirror tekrar acilirsa kullanilir:

| Dosya | Aciklama |
|-------|----------|
| `start_crt_vantage.bat` | Vantage proxy (port 8791) |
| `enable_vantage_algo.bat` | Vantage MT5 algo ac |
| `sync_vantage_pending_to_lotas.ps1` | Bekleyen emirleri Lotas'a kopyala |

Ornek env: `config/vantage/.env.vantage.example` → proje kokune `.env.vantage` olarak kopyala.
