# saniye. — pay for exactly the seconds you use

> **Monad Blitz İstanbul 2026** · Consumer payments on Monad Testnet
>
> 🇹🇷 *Otoparkta 61 dakika kalana 2 saat yazılmaz. Başlat, kullan, durdur: kullandığın saniye kadar ödersin, kalan para aynı işlemde cüzdanına döner.*

**Live demo:** `<VERCEL_URL>` &nbsp;·&nbsp; **Contract (Monad Testnet):** [`0xBDc9bF66b1d850B555E38F922615a6703014Cce6`](https://testnet.monadvision.com/address/0xBDc9bF66b1d850B555E38F922615a6703014Cce6)

---

## The problem

Parking lots, e-scooters, PlayStation cafés, meeting rooms and EV chargers all bill in coarse blocks. Stay 61 minutes, pay for 2 hours. Or leave a deposit and wait days for the refund.

## The solution

1. **Start** – the user locks a small deposit. The gate opens as soon as the transaction confirms.
2. **Use** – a live counter shows seconds used and MON spent, next to what the hourly-rounded price would be.
3. **Stop** – one transaction settles everything: the business gets `seconds × rate`, the platform takes 1%, and the unused deposit goes straight back to the user.

The business dashboard shows active sessions, revenue flowing in real time, and a one-click withdrawal.

**Scan-to-start QR.** Every service gets a QR code (and a full-screen kiosk mode for the gate or counter screen). A customer scans it with their phone, the app opens with a ready browser wallet, and one tap starts the session. The kiosk listens to the chain and shows "Bariyer açıldı" the moment the customer's start transaction lands, then "İyi yolculuklar" with the amount paid when they stop. No app install, no card, no ticket.

**In-app scanner: scan in, scan out.** Customers can also open the camera inside the app: scanning the service QR at the entrance starts the session, scanning the same QR at the exit settles it and refunds the rest. Scanning a different service's QR switches to that service.

## Why this needs Monad

| | Ethereum L1 | Monad |
|---|---|---|
| Block time | 12 s | **0.3 s** |
| Finality | ~13 min | **0.6 s** |

A parking barrier cannot wait 12 seconds for a block, let alone minutes for finality. On Monad, start and stop confirm in well under a second, so a per-second billing model feels like tapping a transit card.

Monad-specific choices in this build:

- **`eth_sendRawTransactionSync`** – the browser wallet sends the signed transaction and gets the receipt back in the same request, so the UI reacts the moment the block lands. The app falls back to send-and-poll if an RPC does not support it. The latency panel shows the measured time from send to receipt.
- **Gas limit is what you pay** – on Monad the sender is charged `gas_price × gas_limit`, not gas used. The frontend estimates gas and adds only a 25% margin instead of a large fixed limit.
- **Only start and stop touch the chain** – the live counter is computed client-side from the on-chain `startedAt`. Billing uses `block.timestamp`, whose one-second granularity is exactly the billing unit, so several 300 ms blocks sharing a timestamp does not matter.
- **Native MON, no approvals** – one transaction to start, one to stop.

## Architecture

```
frontend/ (static: HTML + CSS + viem via ESM)
  ├─ Kullanıcı view  → start(serviceId) payable  → gate opens, live counter
  │                  → stop()                    → pay seconds used, refund rest
  └─ İşletme view    → services / activeUsers / sessions / earnings (Multicall3)
                     → event feed (SessionStarted / SessionStopped / Withdrawn)
                     → withdraw(), registerService()

src/SaniyePay.sol
```

### Contract API (`src/SaniyePay.sol`)

| Function | What it does |
|---|---|
| `registerService(name, ratePerSecond)` | A business lists a service and becomes its owner. |
| `start(serviceId)` *payable* | Locks the deposit (minimum 60 s worth) and records `startedAt`. One active session per address. |
| `stop()` | Pays `elapsed × rate` (capped at the deposit): 99% to the owner, 1% to the treasury. Refunds the rest in the same transaction. |
| `forceStop(user)` | The service owner may close a session whose deposit has run out. |
| `withdraw()` | Pulls accumulated earnings. |
| `quote(user)` / `activeUsers(serviceId)` | Views for the UI. |

Pull-payment for earnings, checks-effects-interactions ordering, custom errors, and swap-and-pop bookkeeping for active sessions.

## Run it

### 1. Deploy the contract

**Option A: Node (no Foundry needed)**

```bash
npm install
PRIVATE_KEY=0xYOUR_TESTNET_KEY npm run deploy
```

This compiles the contract, deploys it to Monad Testnet (chain id 10143), registers the demo service “Kadıköy Otopark” at 0.18 MON/hour, and writes the address into `frontend/config.js`.

**Option B: Foundry v1.8+**

```bash
forge install foundry-rs/forge-std --no-git   # first time only
forge test                                    # runs with Monad execution (network = "monad")
forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $PRIVATE_KEY --broadcast
```

Then paste the printed address into `frontend/config.js` (`contractAddress`, `serviceId`).

Get testnet MON from https://blitz.devnads.com or https://faucet.monad.xyz.

### 2. Run the frontend

```bash
npm run dev          # serves frontend/ at http://localhost:5173
```

Or deploy the `frontend/` folder as a static site (Vercel: set **Root Directory** to `frontend`, no build command).

The app creates a browser wallet on first load (testnet only, key kept in localStorage). Send it a little MON from the wallet drawer (top right), or switch to MetaMask there.

URL options:

- `#kullanici` – user view, `#isletme` – business dashboard
- `?service=2` – open a specific service (the register form prints this link)

## Tests

- `test/SaniyePay.t.sol` – Foundry tests: exact per-second billing and refund, 1% fee split, minimum deposit, double start, `forceStop` only after the deposit is exhausted, withdrawals, and a fuzz test that the contract balance always equals the outstanding earnings.
- During the Blitz the contract was also run through the same scenarios on a local EVM, and the frontend was driven end to end (start → live counter → business view → stop → refund → register service).

## Business model

- 1% platform fee on every settled session (on-chain, in `stop()`).
- B2B: parking operators, scooter fleets, coworking spaces, gaming cafés, EV charging.
- Next: stablecoin deposits (e.g. USDC) so prices are stable, NFC or QR tap-to-start at the gate, and a passkey login so users never see a wallet.

## Built at Monad Blitz İstanbul

All code in this repository was written during the event on 26 September 2026.
