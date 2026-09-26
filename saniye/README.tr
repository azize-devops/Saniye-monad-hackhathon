<div align="center">

**🌐 [English](./README.md) &nbsp;|&nbsp; [Türkçe](./README.tr.md)**

# ⏱️ saniye.

### kullandığın saniye kadar öde

*Otoparkta 61 dakika kalana 2 saat yazılmaz.*
*Başlat, kullan, durdur: kullandığın saniye kadar ödersin, kalan para aynı işlemde cüzdanına döner.*

<br/>

[![Monad Testnet](https://img.shields.io/badge/Monad-Testnet-836EF9?style=for-the-badge&logo=ethereum&logoColor=white)](https://testnet.monadvision.com)
[![Blitz İstanbul 2026](https://img.shields.io/badge/Monad%20Blitz-İstanbul%202026-1a1a2e?style=for-the-badge)](#)
[![Solidity](https://img.shields.io/badge/Solidity-Foundry-363636?style=for-the-badge&logo=solidity&logoColor=white)](#testler)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](#)

**[🔴 Canlı Demo](<VERCEL_URL>)** &nbsp;|&nbsp; **[📜 Monad Testnet Kontratı](https://testnet.monadvision.com/address/0xBDc9bF66b1d850B555E38F922615a6703014Cce6)**

</div>

<br/>

---

## 🅿️ Problem

Otopark, e-scooter, PlayStation kafe, toplantı odası ve EV şarj gibi hizmetlerin hepsi kaba bloklar halinde ücretlendirir. 61 dakika kalırsın, 2 saatlik ücret ödersin. Ya da depozito bırakır, iadesi için günlerce beklersin.

Türkiye'de otopark ücreti ödeyen herkes bunu yaşamıştır. **saniye.** bunu mümkün olan en küçük birimde çözüyor: saniye.

## ✅ Çözüm

```
   BAŞLAT                   KULLAN                       DURDUR
┌──────────┐        ┌──────────────────┐        ┌──────────────────────┐
│ Depozito  │  ───▶  │  Canlı sayaç:     │  ───▶  │  Tek işlemde ödeme:   │
│ kilitlenir│        │  kullanılan       │        │  işletme hak ettiğini │
│ bariyer   │        │  saniye × ücret,  │        │  alır, kullanılmayan  │
│ açılır    │        │  saatlik yuvarlama│        │  depozito anında      │
│           │        │  ile karşılaştır. │        │  iade edilir          │
└──────────┘        └──────────────────┘        └──────────────────────┘
```

1. **Başlat** — kullanıcı küçük bir depozito kilitler. İşlem onaylanır onaylanmaz bariyer açılır.
2. **Kullan** — canlı bir sayaç, kullanılan saniyeyi ve harcanan MON'u, saatlik yuvarlanmış ücretle yan yana gösterir.
3. **Durdur** — tek bir işlem her şeyi çözer: işletme `saniye × ücret` kadarını alır, platform %1 komisyon keser, kullanılmayan depozito doğrudan kullanıcıya geri döner.

İşletme panelinde aktif oturumlar, gerçek zamanlı akan gelir ve tek tıkla para çekme yer alır.

### 📱 Taratarak Başlat (QR)

Her hizmetin bir QR kodu — ve bariyer veya sayaç ekranı için tam ekran kiosk modu vardır. Müşteri telefonuyla kodu taratır, uygulama hazır bir tarayıcı cüzdanıyla açılır ve tek dokunuşla oturum başlar. Kiosk zinciri dinler ve müşterinin başlatma işlemi zincire düştüğü an **"Bariyer açıldı"**, durdurduğunda ise ödenen tutarla birlikte **"İyi yolculuklar"** yazısını gösterir.

Uygulama indirmeye gerek yok. Kart yok. Bilet yok.

<br/>

---

## ⚡ Bu neden Monad gerektiriyor

Bir otopark bariyeri bir blok için 12 saniye, finality için de dakikalarca bekleyemez. Monad'da başlat ve durdur işlemleri bir saniyeden çok daha kısa sürede onaylanır — saniye bazlı ücretlendirme, bir toplu taşıma kartını okutmak kadar doğal hissettirir.

| | Ethereum L1 | **Monad** |
|---|:---:|:---:|
| Blok süresi | 12 sn | **0,3 sn** |
| Finality | ~13 dk | **0,6 sn** |

### Bu projede Monad'a özgü tercihler

- **`eth_sendRawTransactionSync`** — tarayıcı cüzdanı imzalanmış işlemi gönderir ve aynı istekte makbuzu geri alır, böylece arayüz blok zincire düştüğü an tepki verir. Bir RPC bunu desteklemiyorsa uygulama gönder-ve-bekle yöntemine geri döner. Gecikme paneli, gönderimden makbuza kadar geçen ölçülen süreyi gösterir.
- **Ödediğin şey gas limitidir** — Monad'da gönderen, kullanılan gas için değil, `gas_price × gas_limit` üzerinden ücretlendirilir. Arayüz gas'ı tahmin eder ve büyük sabit bir limit yerine sadece %25 pay ekler.
- **Zincire yalnızca başlat ve durdur dokunur** — canlı sayaç, zincir üzerindeki `startedAt` değerinden istemci tarafında hesaplanır. Ücretlendirme `block.timestamp` kullanır; bu, birim zaten saniye olduğu için tam olarak faturalama birimidir, dolayısıyla aynı saniyeye düşen birkaç 300 ms'lik blok sorun yaratmaz.
- **Native MON, onay (approval) yok** — başlatmak için bir işlem, durdurmak için bir işlem.

<br/>

---

## 🏗️ Mimari

```
frontend/ (statik: HTML + CSS + viem, ESM ile)
  ├─ Kullanıcı view  → start(serviceId) payable  → bariyer açılır, canlı sayaç
  │                  → stop()                    → kullanılan saniyeyi öde, kalanı iade et
  └─ İşletme view    → services / activeUsers / sessions / earnings (Multicall3)
                     → olay akışı (SessionStarted / SessionStopped / Withdrawn)
                     → withdraw(), registerService()

src/SaniyePay.sol
```

### Kontrat API'si — `src/SaniyePay.sol`

| Fonksiyon | Ne yapar |
|---|---|
| `registerService(name, ratePerSecond)` | Bir işletme hizmet kaydeder ve o hizmetin sahibi olur. |
| `start(serviceId)` *payable* | Depozitoyu kilitler (en az 60 saniyelik tutar) ve `startedAt`'i kaydeder. Adres başına tek aktif oturum. |
| `stop()` | `geçen süre × ücret` kadarını öder (depozitoyla sınırlı): %99 hizmet sahibine, %1 hazineye. Kalanı aynı işlemde iade eder. |
| `forceStop(user)` | Hizmet sahibi, depozitosu tükenmiş bir oturumu kapatabilir. |
| `withdraw()` | Birikmiş kazancı çeker. |
| `quote(user)` / `activeUsers(serviceId)` | Arayüz için görünüm (view) fonksiyonları. |

Kazançlar için pull-payment yöntemi, checks-effects-interactions sıralaması, özel hata (custom error) tipleri ve aktif oturumlar için swap-and-pop kayıt tutma yöntemi kullanılmıştır.

<br/>

---

## 🚀 Nasıl çalıştırılır

### 1. Kontratı deploy et

**Seçenek A — Node (Foundry gerekmez)**

```bash
npm install
PRIVATE_KEY=0xYOUR_TESTNET_KEY npm run deploy
```

Bu komut kontratı derler, Monad Testnet'e (chain id `10143`) deploy eder, demo hizmeti **"Kadıköy Otopark"**'ı `0,18 MON/saat` ücretle kaydeder ve adresi `frontend/config.js` dosyasına yazar.

**Seçenek B — Foundry v1.8+**

```bash
forge install foundry-rs/forge-std --no-git   # sadece ilk seferde
forge test                                    # Monad execution ile çalışır (network = "monad")
forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $PRIVATE_KEY --broadcast
```

Ardından yazdırılan adresi `frontend/config.js` içine yapıştır (`contractAddress`, `serviceId`).

> Testnet MON almak için: [blitz.devnads.com](https://blitz.devnads.com) veya [faucet.monad.xyz](https://faucet.monad.xyz).

### 2. Arayüzü çalıştır

```bash
npm run dev          # frontend/ dizinini http://localhost:5173 adresinde sunar
```

Ya da `frontend/` klasörünü statik bir site olarak deploy et (Vercel: **Root Directory**'yi `frontend` olarak ayarla, build komutu gerekmez).

Uygulama ilk açılışta bir tarayıcı cüzdanı oluşturur (yalnızca testnet, anahtar `localStorage`'da tutulur). Sağ üstteki cüzdan çekmecesinden biraz MON gönder, ya da oradan MetaMask'a geç.

**URL seçenekleri:**

| Yol | Sonuç |
|---|---|
| `#kullanici` | Kullanıcı görünümü |
| `#isletme` | İşletme paneli |
| `?service=2` | Belirli bir hizmeti açar (kayıt formu bu linki yazdırır) |

<br/>

---

## 🧪 Testler

- `test/SaniyePay.t.sol` — Foundry testleri: tam saniye bazlı ücretlendirme ve iade, %1 komisyon paylaşımı, minimum depozito, çift başlatma engeli, `forceStop`'un yalnızca depozito tükendikten sonra çalışması, para çekme işlemleri ve kontrat bakiyesinin her zaman ödenmemiş kazançlara eşit olduğunu doğrulayan bir fuzz testi.
- Blitz sırasında kontrat aynı senaryolarla yerel bir EVM üzerinde de test edildi, arayüz ise uçtan uca çalıştırıldı (başlat → canlı sayaç → işletme görünümü → durdur → iade → hizmet kaydı).

<br/>

---

## 💼 İş modeli

- Her tamamlanan oturumda **%1 platform komisyonu** — zincir üstünde, `stop()` içinde.
- **B2B:** otopark işletmeleri, scooter filoları, coworking alanları, oyun kafeleri, EV şarj noktaları.
- **Sırada:** fiyatların sabit kalması için stablecoin depozito (örn. USDC), bariyerde NFC veya QR ile dokunup başlatma, ve kullanıcıların cüzdan hiç görmemesi için passkey ile giriş.

<br/>

---

## 👥 Monad Blitz İstanbul'da geliştirildi

Bu depodaki tüm kod, etkinlik sırasında **26 Eylül 2026** tarihinde yazılmıştır.

<div align="center">

| | | |
|:---:|:---:|:---:|
| **Azize Dursun** | **Muharrem Midilli** | **İlayda Kaptanoğlu** |

</div>

<br/>

<div align="center">

*Monad Testnet üzerinde ⚡ ile yapıldı*

</div>
