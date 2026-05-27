// OneSwap Price Monitor v2
// Upgraded from monolithic → modular using shared lib/ from oneswap-bot
//
// Features:
//   - Poll CC/USDCx and CC/CBTC reserves every POLL_SECONDS
//   - Threshold alerts (absolute price low/high) with hysteresis + rearm
//   - Whale detector: alert when single-tick reserveA delta exceeds threshold %
//   - Rebound tracker: announce when price recovers post-whale
//   - On-demand: /price /status /quote /help + inline buttons
//   - Authenticated quote via OneswapClient (challenge→sign→verify)
//   - Persistent state in state.json
//
// Architecture:
//   src/bot.js          ← main loop + tick logic
//   src/telegram.js     ← TG polling, commands, keyboards
//   src/alerts.js       ← zone/whale/rebound detection + alert formatting
//   lib/oneswap.js      ← shared OneswapClient (auth + API)
//   lib/wallet.js       ← Ed25519 wallet (sign)
//   lib/notifier.js     ← Telegram send helper
//   lib/util.js         ← hex/base64/sleep helpers

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OneswapClient } from '../lib/oneswap.js';
import { Wallet } from '../lib/wallet.js';
import { TelegramNotifier } from '../lib/notifier.js';
import { sleep, nowIso } from '../lib/util.js';
import { pollTelegramUpdates, setCommands, sendStartupMessage, buildPriceReport, buildStatusReport, buildQuoteReply } from './telegram.js';
import { detectWhale, handleWhaleAndRebound, checkAlertZone } from './alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------
function csvNums(envVal) {
  if (!envVal) return [];
  return envVal.split(',').map((s) => Number(s.trim())).filter((n) => isFinite(n) && n > 0);
}

export const cfg = {
  api: process.env.ONESWAP_API || 'https://api.oneswap.cc',
  pollSec: Number(process.env.POLL_SECONDS || 30),
  rearmSec: Number(process.env.REARM_SECONDS || 900),
  reboundMin: Number(process.env.REBOUND_WATCH_MINUTES || 15),
  reboundPct: Number(process.env.REBOUND_RECOVER_PCT || 80),
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  // Auth (optional — enables authenticated quote endpoint)
  privHex: process.env.PRIVATE_KEY_HEX || '',
  pubHex: process.env.PUBLIC_KEY_HEX || '',
  partyId: process.env.RECEIVER_PARTY || '',
  quotePresets: {
    USDCx: csvNums(process.env.QUOTE_PRESETS_USDCX),
    CC: csvNums(process.env.QUOTE_PRESETS_CC),
    CBTC: csvNums(process.env.QUOTE_PRESETS_CBTC),
  },
  pairs: [
    {
      key: 'CC_USDCX',
      label: 'CC/USDCx',
      poolId: process.env.POOL_CC_USDCX,
      base: 'CC', quote: 'USDCx',
      low: Number(process.env.CC_USDCX_LOW),
      high: Number(process.env.CC_USDCX_HIGH),
      whalePct: Number(process.env.CC_USDCX_WHALE_PCT || 2.0),
      decimals: 6,
      reserveBDecimals: 2,
    },
    {
      key: 'CC_CBTC',
      label: 'CC/CBTC',
      poolId: process.env.POOL_CC_CBTC,
      base: 'CC', quote: 'CBTC',
      low: Number(process.env.CC_CBTC_LOW),
      high: Number(process.env.CC_CBTC_HIGH),
      whalePct: Number(process.env.CC_CBTC_WHALE_PCT || 5.0),
      decimals: 10,
      reserveBDecimals: 6,
    },
  ],
};

// ---------- Validation ----------
if (!cfg.tgToken || !cfg.tgChat) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required in .env');
  process.exit(1);
}
for (const p of cfg.pairs) {
  if (!p.poolId) { console.error(`FATAL: missing poolId for ${p.key}`); process.exit(1); }
  if (!isFinite(p.low) || !isFinite(p.high)) {
    console.error(`FATAL: missing numeric thresholds for ${p.key}`); process.exit(1);
  }
}

// ---------- State ----------
const STATE_FILE = path.join(__dirname, '..', 'state.json');
export let state = { pairs: {} };
try {
  if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (e) {
  console.warn('failed to load state, starting fresh:', e.message);
}
export function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}
for (const p of cfg.pairs) {
  if (!state.pairs[p.key]) {
    state.pairs[p.key] = {
      lastPrice: null,
      lastReserveA: null,
      lastReserveB: null,
      zone: 'normal',
      lastAlertAt: 0,
      activeWhale: null,
    };
  }
}
saveState();

// ---------- Logger ----------
export const log = (lvl, msg, extra = '') =>
  console.log(`${new Date().toISOString()} ${lvl.padEnd(5)} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);

export const fmtPrice = (v, d) => isFinite(v) ? v.toFixed(d) : 'N/A';
export const pctChange = (a, b) => a ? ((b - a) / a) * 100 : 0;

export function durationStr(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}m ${ss}s`;
}

// ---------- Shared instances ----------
export const tg = new TelegramNotifier({ botToken: cfg.tgToken, chatId: cfg.tgChat });

// OneSwap client (authenticated if keys provided, otherwise read-only fallback)
export let oneswap = null;

async function initOneswapClient() {
  if (cfg.privHex && cfg.pubHex && cfg.partyId) {
    try {
      const wallet = new Wallet(cfg.privHex, cfg.pubHex);
      await wallet.ensureMatch();
      oneswap = new OneswapClient({
        baseUrl: cfg.api,
        wallet,
        partyId: cfg.partyId,
        logger: { info: (...a) => log('info', a.join(' ')), warn: (...a) => log('warn', a.join(' ')) },
      });
      await oneswap.login();
      log('info', '✓ OneswapClient authenticated (challenge→sign→verify)');
      return;
    } catch (e) {
      log('warn', `Auth failed, falling back to read-only: ${e.message}`);
    }
  }
  // Fallback: unauthenticated fetch
  log('info', 'Running in read-only mode (no PRIVATE_KEY_HEX / RECEIVER_PARTY)');
}

// ---------- API fallback (unauthenticated) ----------
export async function fetchReserves(poolId) {
  const url = `${cfg.api}/api/v2/pools/${poolId}/reserves`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`reserves ${res.status}`);
  return await res.json();
}

export async function fetchQuote(poolId, inputToken, inputAmount) {
  // Use authenticated client if available
  if (oneswap) {
    return await oneswap.getQuote({ poolId, inputToken, inputAmount });
  }
  // Fallback: public endpoint (needs receiverParty in URL)
  const params = new URLSearchParams({ inputToken, inputAmount: String(inputAmount) });
  if (cfg.partyId) params.set('receiverParty', cfg.partyId);
  const url = `${cfg.api}/api/v2/pools/${poolId}/quote?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`quote ${res.status}`);
  return await res.json();
}

export async function fetchPairData(p) {
  const r = await fetchReserves(p.poolId);
  return {
    pair: p,
    price: Number(r.rate),
    inversePrice: Number(r.inverseRate),
    reserveA: Number(r.reserveA),
    reserveB: Number(r.reserveB),
    tokenA: r.tokenA?.id,
    tokenB: r.tokenB?.id,
  };
}

// ---------- Tick ----------
async function tick() {
  for (const p of cfg.pairs) {
    try {
      const d = await fetchPairData(p);
      const s = state.pairs[p.key];
      const prev = s.lastPrice;

      // 1) Whale detect (BEFORE zone update)
      const whale = detectWhale(p, d, s);
      const events = handleWhaleAndRebound(p, d, s, whale, prev);

      // 2) Zone-based threshold
      const zoneAlert = checkAlertZone(p, d.price, s);

      // 3) Update state cache
      s.lastPrice = d.price;
      s.lastReserveA = d.reserveA;
      s.lastReserveB = d.reserveB;
      saveState();

      log('info', `${p.key} price=${fmtPrice(d.price, p.decimals)} zone=${s.zone}` +
        (prev ? ` Δ=${pctChange(prev, d.price).toFixed(2)}%` : '') +
        (whale ? ` 🐋whale=${whale.kind}/${whale.pctA.toFixed(2)}%` : '') +
        (s.activeWhale ? ` [watching ${s.activeWhale.kind}]` : ''));

      // 4) Emit Telegram messages (imported from telegram.js)
      const { sendWhaleAlert, sendReboundAlert, sendZoneAlert } = await import('./telegram.js');
      if (events.whaleAlert) await sendWhaleAlert(p, d, s.activeWhale, events.whaleAlert);
      if (events.reboundAlert) await sendReboundAlert(p, d, events.reboundAlert);
      if (zoneAlert) await sendZoneAlert(p, d, prev, zoneAlert);

    } catch (e) {
      log('error', `tick ${p.key} failed: ${e.message?.slice(0, 200)}`);
    }
  }
}

// ---------- Main ----------
async function main() {
  log('info', '═══ OneSwap Price Monitor v2 starting ═══', {
    pairs: cfg.pairs.map((p) => p.key),
    pollSec: cfg.pollSec,
    rearmSec: cfg.rearmSec,
    reboundMin: cfg.reboundMin,
    authenticated: !!(cfg.privHex && cfg.pubHex),
  });

  await initOneswapClient();
  await setCommands();
  await sendStartupMessage();

  // Baseline tick
  await tick();

  // Telegram long-polling in background
  pollTelegramUpdates(tick).catch((e) => log('error', `pollUpdates fatal: ${e.message}`));

  // Main polling loop
  while (true) {
    await sleep(cfg.pollSec * 1000);
    await tick();
  }
}

process.on('SIGINT', () => { log('warn', 'SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { log('warn', 'SIGTERM'); process.exit(0); });

main().catch((e) => { log('error', `fatal: ${e.message}`); process.exit(1); });
