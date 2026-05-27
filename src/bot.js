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
import { CantonClient } from '../lib/canton.js';
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
  // Auth (optional — enables authenticated quote + swap)
  privHex: process.env.PRIVATE_KEY_HEX || '',
  pubHex: process.env.PUBLIC_KEY_HEX || '',
  partyId: process.env.RECEIVER_PARTY || '',
  cantonBaseUrl: process.env.CANTON_BASE_URL || 'https://consolewallet.io',
  slippage: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.05'),
  swapCooldownSec: parseInt(process.env.SWAP_COOLDOWN_SEC || '60', 10),
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
export let canton = null;
export let wallet = null;

// Swap state
let swapCooldownUntil = 0;
let swapInProgress = false;

export function isSwapCapable() {
  return !!(oneswap && canton && cfg.privHex && cfg.pubHex && cfg.partyId);
}

export function isSwapOnCooldown() {
  return Date.now() < swapCooldownUntil;
}

export function getSwapCooldownRemaining() {
  return Math.max(0, Math.ceil((swapCooldownUntil - Date.now()) / 1000));
}

async function initOneswapClient() {
  if (cfg.privHex && cfg.pubHex && cfg.partyId) {
    try {
      wallet = new Wallet(cfg.privHex, cfg.pubHex);
      await wallet.ensureMatch();

      const logger = { info: (...a) => log('info', a.join(' ')), warn: (...a) => log('warn', a.join(' ')) };

      // Init Canton client (for balance + transfer)
      canton = new CantonClient({
        baseUrl: cfg.cantonBaseUrl,
        wallet,
        partyId: cfg.partyId,
        logger,
      });
      await canton.login();
      log('info', '✓ CantonClient logged in');

      // Init OneSwap client (for quote + intent)
      oneswap = new OneswapClient({
        baseUrl: cfg.api,
        wallet,
        partyId: cfg.partyId,
        logger,
      });
      await oneswap.login();
      log('info', '✓ OneswapClient authenticated (challenge→sign→verify)');

      // Get initial balance
      const bal = await canton.getBalances();
      const ccBal = bal.balances?.find(b => b.coin === 'CC')?.balance || '0';
      const usdcxBal = bal.balances?.find(b => b.coin === 'USDCx')?.balance || '0';
      log('info', `Balance: CC=${ccBal}, USDCx=${usdcxBal}`);
      return;
    } catch (e) {
      log('warn', `Auth failed, falling back to read-only: ${e.message}`);
      oneswap = null;
      canton = null;
      wallet = null;
    }
  }
  // Fallback: unauthenticated fetch
  log('info', 'Running in read-only mode (no PRIVATE_KEY_HEX / RECEIVER_PARTY)');
}

// ---------- Balance ----------
export async function getBalances() {
  if (!canton) return null;
  try {
    const bal = await canton.getBalances();
    return {
      CC: parseFloat(bal.balances?.find(b => b.coin === 'CC')?.balance || '0'),
      USDCx: parseFloat(bal.balances?.find(b => b.coin === 'USDCx')?.balance || '0'),
      CBTC: parseFloat(bal.balances?.find(b => b.coin === 'CBTC')?.balance || '0'),
    };
  } catch (e) {
    log('error', `getBalances failed: ${e.message}`);
    return null;
  }
}

// ---------- Swap Execution ----------
/**
 * Execute a swap: createSwapIntent → Canton transfer → poll completion
 * @param {object} params
 * @param {string} params.pairKey - 'CC_USDCX' or 'CC_CBTC'
 * @param {string} params.inputToken - 'CC', 'USDCx', or 'CBTC'
 * @param {string} params.amount - decimal amount
 * @returns {object} result with status, actualOutput, etc.
 */
export async function executeSwap({ pairKey, inputToken, amount }) {
  if (!isSwapCapable()) throw new Error('Swap not configured (need PRIVATE_KEY_HEX + RECEIVER_PARTY)');
  if (swapInProgress) throw new Error('Swap already in progress');
  if (isSwapOnCooldown()) throw new Error(`Cooldown active (${getSwapCooldownRemaining()}s remaining)`);

  const p = cfg.pairs.find(x => x.key === pairKey);
  if (!p) throw new Error(`Unknown pair: ${pairKey}`);

  const outputToken = inputToken === 'CC' ? p.quote : 'CC';

  swapInProgress = true;
  try {
    // 1. Quote first
    const q = await oneswap.getQuote({ poolId: p.poolId, inputToken, inputAmount: amount });
    const outAmt = parseFloat(q.outputAmount ?? q.expectedOutputAmount ?? '0');
    const rate = outAmt / parseFloat(amount);
    log('info', `Swap quote: ${amount} ${inputToken} → ${outAmt.toFixed(6)} ${outputToken} (rate=${rate.toFixed(8)})`);

    // 2. Create swap intent
    const minOut = (outAmt * (1 - cfg.slippage)).toFixed(8);
    const intent = await oneswap.createSwapIntent({
      poolId: p.poolId,
      inputToken,
      amount: String(amount),
      expectedOutputAmount: outAmt.toFixed(8),
      minOutputAmount: minOut,
      slippageTolerance: cfg.slippage,
    });
    log('info', `Intent created: ${intent.intentId}, deposit→${intent.depositAddress}`);

    // 3. Send Canton transfer (with memo = deposit reference)
    const cantonCoin = inputToken; // CC or USDCx
    const { prepared, submitted } = await canton.sendCoin({
      receiver: intent.depositAddress,
      amount: intent.expectedAmount || String(amount),
      coin: cantonCoin,
      memo: intent.depositReference,
    });
    log('info', `Canton transfer submitted: ledgerEnd=${submitted.ledgerEnd}`);

    // 4. Poll for completion
    const final = await oneswap.pollIntent(p.poolId, intent.intentId, { maxWaitSec: 300, intervalSec: 5 });
    log('info', `Final status: ${final.status}, actualOutput: ${final.actualOutputAmount} ${final.actualOutputToken}`);

    // Set cooldown
    swapCooldownUntil = Date.now() + cfg.swapCooldownSec * 1000;

    return {
      status: final.status,
      intentId: intent.intentId,
      inputToken,
      inputAmount: amount,
      outputToken: final.actualOutputToken || outputToken,
      outputAmount: final.actualOutputAmount || outAmt.toFixed(6),
      rate: rate.toFixed(8),
      priceImpact: q.priceImpact,
      slippage: cfg.slippage,
      autoReceive: inputToken !== 'CC', // USDCx/CBTC in → CC out = auto; CC in → USDCx out = manual accept
    };
  } catch (e) {
    swapInProgress = false;
    throw e;
  } finally {
    swapInProgress = false;
  }
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
