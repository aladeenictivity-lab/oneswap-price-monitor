# OneSwap Price Monitor v2

Real-time price monitor for **CC/USDCx** and **CC/CBTC** pools on OneSwap DEX (Canton Network). Sends Telegram alerts for whale movements, threshold breaches, and price rebounds.

## Features

- 📊 **Live price polling** — every 30s (configurable)
- 🐋 **Whale detector** — alerts when reserve delta exceeds threshold %
- ✅ **Rebound tracker** — announces price recovery post-whale
- 🚀 **Threshold alerts** — high/low price alerts with hysteresis + rearm
- 📋 **Quote bot** — read-only quote via `/quote CC 500`
- 🔐 **Authenticated mode** — optional Ed25519 auth for full API access
- 💾 **Persistent state** — survives restarts via `state.json`

## Quick Start

```bash
git clone https://github.com/aladeenictivity-lab/oneswap-price-monitor.git
cd oneswap-price-monitor
npm install
cp .env.example .env
# Edit .env with your Telegram bot token + chat ID
npm start
```

## Architecture

```
src/
├── bot.js          Main loop + tick logic
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
| `/status` | Monitor config + state |
| `/quote CC 500` | Quote 500 CC → USDCx |
| `/quote USDCx 100` | Quote 100 USDCx → CC |
| `/help` | Help message |

## Alerts

### Whale Detection
- Monitors reserveA delta between ticks
- CC/USDCx: alert if reserveA changes ≥ 2%
- CC/CBTC: alert if reserveA changes ≥ 5%
- Tracks cumulative whale events (extends same-direction, alerts on direction flip)

### Rebound Tracking
- After whale event, watches for price recovery
- Alerts when recovery ≥ 80% of the whale move (configurable)
- Auto-expires after 15 minutes (configurable)

### Threshold Breach
- Alerts when price crosses configured high/low boundaries
- Hysteresis: only alerts on zone *change* (not repeat)
- Re-arm timer: minimum 15 minutes between same-zone alerts

## Configuration

All config via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_SECONDS` | 30 | Polling interval |
| `REARM_SECONDS` | 900 | Minimum seconds between same-zone alerts |
| `REBOUND_WATCH_MINUTES` | 15 | How long to watch for rebound |
| `REBOUND_RECOVER_PCT` | 80 | % recovery to trigger rebound alert |
| `CC_USDCX_LOW` | — | Low threshold for CC/USDCx |
| `CC_USDCX_HIGH` | — | High threshold for CC/USDCx |
| `CC_USDCX_WHALE_PCT` | 2.0 | Whale detection threshold (%) |

## Authentication (Optional)

For full API access (authenticated quotes), provide Ed25519 keys:

```bash
PRIVATE_KEY_HEX=your_64char_hex_seed
PUBLIC_KEY_HEX=your_64char_hex_pubkey
RECEIVER_PARTY=consolewallet-xxx::xxx
```

Without keys, the monitor runs in read-only mode using public endpoints.

## Running as Background Process

```bash
# Using screen
screen -dmS oneswap-monitor node src/bot.js

# Using systemd
# See deployment docs
```

## Related

- [oneswap-cantonpumpfun](https://github.com/aladeenictivity-lab/oneswap-cantonpumpfun) — Auto-swap bot (CC↔USDCx)

## License

MIT
