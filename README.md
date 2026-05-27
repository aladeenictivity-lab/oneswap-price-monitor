# OneSwap Price Monitor v2

Real-time price monitor + **swap executor** for **CC/USDCx** and **CC/CBTC** pools on OneSwap DEX (Canton Network).

## Features

- 📊 **Live price polling** — every 30s (configurable)
- 🐋 **Whale detector** — alerts when reserve delta exceeds threshold %
- ✅ **Rebound tracker** — announces price recovery post-whale
- 🚀 **Threshold alerts** — high/low price alerts with hysteresis + rearm
- 📋 **Quote bot** — read-only quote via `/quote CC 500`
- 🔄 **Swap execution** — execute swaps from Telegram with confirmation
- 🔐 **Authenticated** — Ed25519 auth for full API access
- 💾 **Persistent state** — survives restarts via `state.json`

## Quick Start

```bash
git clone https://github.com/aladeenictivity-lab/oneswap-price-monitor.git
cd oneswap-price-monitor
npm install
cp .env.example .env
# Edit .env with your Telegram bot token + chat ID + wallet keys
npm start
```

## Architecture

```
src/
├── bot.js          Main loop + tick + swap execution
├── telegram.js     TG polling, commands, keyboards, alert formatting
└── alerts.js       Whale/zone/rebound detection logic

lib/                Shared modules (same as oneswap-cantonpumpfun)
├── oneswap.js      OneSwap API client (auth + quote + intent)
├── wallet.js       Ed25519 wallet (sign)
├── canton.js       Canton API client (login + transfer)
├── notifier.js     Telegram send helper
└── util.js         Hex/base64/sleep utilities
```

## Commands

| Command | Description |
|---------|-------------|
| `/price` | Current price for all pairs |
| `/balance` | Check CC/USDCx/CBTC balance |
| `/swap CC 100` | Preview swap 100 CC → USDCx |
| `/swap USDCx 50` | Preview buy CC with 50 USDCx |
| `/status` | Monitor config + swap status |
| `/quote CC 500` | Quote 500 CC → USDCx (read-only) |
| `/help` | Help message |

## Swap Flow

```
User: /swap CC 100
  ↓
Bot: Preview (rate, impact, min out, balance check)
  ↓  [CONFIRM] button
User: taps CONFIRM
  ↓
Bot: createSwapIntent → Canton transfer → poll completion
  ↓
Bot: ✅ Swap completed (or ⚠️ need manual accept for CC→USDCx)
```

### Swap from Alerts
Whale alerts include **instant swap buttons** — when a whale dumps, you get:
```
🐋📉 CC/USDCx — WHALE DUMP!
...
🎯 BUY ZONE 💡

[🔄 Swap 500 CC] [🔄 Swap 1000 CC] [🔄 Swap 2000 CC]
```

### Persistent Keyboard
Bottom keyboard with quick-swap presets:
```
[💰 BUY 50 USDCx] [💰 BUY 100 USDCx] [💰 BUY 200 USDCx]
[📤 SELL 500 CC]   [📤 SELL 1000 CC]   [📤 SELL 2000 CC]
[📊 Price]  [💰 Balance]  [🛟 Status]
```

## Alerts

### Whale Detection
- Monitors reserveA delta between ticks
- CC/USDCx: alert if reserveA changes ≥ 2%
- CC/CBTC: alert if reserveA changes ≥ 5%
- Cumulative tracking (extends same-direction, alerts on direction flip)

### Rebound Tracking
- After whale event, watches for price recovery
- Alerts when recovery ≥ 80% of the whale move
- Auto-expires after 15 minutes

### Threshold Breach
- Alerts when price crosses configured high/low boundaries
- Hysteresis: only alerts on zone change
- Re-arm timer: minimum 15 minutes between same-zone alerts

## Configuration

All config via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_SECONDS` | 30 | Polling interval |
| `REARM_SECONDS` | 900 | Min seconds between same-zone alerts |
| `REBOUND_WATCH_MINUTES` | 15 | How long to watch for rebound |
| `REBOUND_RECOVER_PCT` | 80 | % recovery to trigger rebound alert |
| `CC_USDCX_LOW/HIGH` | — | Threshold for CC/USDCx |
| `SLIPPAGE_TOLERANCE` | 0.05 | Max slippage for swap execution (5%) |
| `SWAP_COOLDOWN_SEC` | 60 | Cooldown between swaps |

## Swap Safety

- **Confirmation required** — every swap needs explicit CONFIRM tap
- **Balance check** — preview shows if you have enough funds
- **Slippage protection** — min output enforced (configurable)
- **Cooldown** — prevents accidental rapid swaps
- **Intent polling** — waits for on-chain completion before confirming
- **CC→USDCx warning** — output needs manual accept in Console Wallet

## Related

- [oneswap-cantonpumpfun](https://github.com/aladeenictivity-lab/oneswap-cantonpumpfun) — Auto-swap bot (CC↔USDCx)

## License

MIT
