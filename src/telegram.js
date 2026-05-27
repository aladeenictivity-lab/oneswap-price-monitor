// Telegram commands, keyboards, and message handlers
import { cfg, state, tg, oneswap, fetchPairData, fetchQuote, log, fmtPrice, pctChange, durationStr } from './bot.js';

const tgApi = `https://api.telegram.org/bot${cfg.tgToken}`;

async function tgSend(text, opts = {}) {
  try {
    const res = await fetch(`${tgApi}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.tgChat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...opts,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return await res.json();
  } catch (e) {
    log('warn', 'tg send failed', { err: e.message?.slice(0, 200) });
  }
}

async function tgAnswerCallback(callbackQueryId, text = '') {
  try {
    await fetch(`${tgApi}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

// ---------- Keyboards ----------
function persistentReplyKeyboard() {
  const usdcx = cfg.quotePresets.USDCx || [];
  const cc = cfg.quotePresets.CC || [];
  const cbtc = cfg.quotePresets.CBTC || [];
  const rows = [];
  if (usdcx.length) rows.push(usdcx.map((a) => ({ text: `💰 BUY ${a} USDCx` })));
  if (cc.length) rows.push(cc.map((a) => ({ text: `📤 SELL ${a} CC` })));
  if (cbtc.length) rows.push(cbtc.map((a) => ({ text: `🪙 BUY ${a} CBTC` })));
  rows.push([{ text: '📊 Price' }, { text: '🛟 Status' }, { text: '❓ Help' }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, selective: false };
}

// ---------- Commands ----------
export async function setCommands() {
  try {
    await fetch(`${tgApi}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'price', description: 'Cek harga semua pair' },
          { command: 'status', description: 'Threshold + state monitor' },
          { command: 'quote', description: 'Quote: /quote CC 500' },
          { command: 'help', description: 'Bantuan' },
        ],
      }),
    });
  } catch (e) { log('warn', 'setMyCommands failed', { err: e.message?.slice(0, 100) }); }
}

// ---------- Reports ----------
export async function buildPriceReport() {
  const lines = ['💱 <b>OneSwap Price</b>', `<i>${new Date().toISOString()}</i>`, ''];
  for (const p of cfg.pairs) {
    try {
      const d = await fetchPairData(p);
      const s = state.pairs[p.key];
      const change = s.lastPrice ? pctChange(s.lastPrice, d.price) : 0;
      const arrow = change > 0.5 ? '📈' : change < -0.5 ? '📉' : '➡️';
      const liq = `${d.reserveA.toFixed(0)} ${d.tokenA} / ${d.reserveB.toFixed(p.reserveBDecimals)} ${d.tokenB}`;
      lines.push(
        `<b>${p.label}</b> ${arrow}`,
        `  <code>${fmtPrice(d.price, p.decimals)}</code> ${p.quote}/${p.base}` +
          (s.lastPrice ? ` (Δ ${change.toFixed(2)}%)` : ''),
        `  1 ${p.quote} = <code>${fmtPrice(d.inversePrice, 4)}</code> ${p.base}`,
        `  Range alert: <code>${fmtPrice(p.low, p.decimals)}</code> ↔ <code>${fmtPrice(p.high, p.decimals)}</code>`,
        `  Zone: <b>${s.zone}</b>${s.activeWhale ? ` 🐋 watching ${s.activeWhale.kind}` : ''}`,
        `  Liq: ${liq}`,
        ''
      );
    } catch (e) {
      lines.push(`<b>${p.label}</b> ⚠️ fetch failed: ${e.message?.slice(0, 100)}`, '');
    }
  }
  return lines.join('\n');
}

export async function buildStatusReport() {
  const authStatus = oneswap ? '🔐 authenticated' : '👁 read-only';
  const lines = [
    '🟢 <b>Monitor Status</b>',
    `Mode: ${authStatus}`,
    `Poll: <b>${cfg.pollSec}s</b>  Re-arm: <b>${cfg.rearmSec}s</b>`,
    `Whale rebound watch: <b>${cfg.reboundMin}m</b> @ <b>${cfg.reboundPct}%</b> recovery`,
    '',
    '<b>Per pair config:</b>',
  ];
  for (const p of cfg.pairs) {
    const s = state.pairs[p.key];
    lines.push(
      `<b>${p.label}</b>`,
      `  HIGH alert ≥ <code>${fmtPrice(p.high, p.decimals)}</code>`,
      `  LOW  alert ≤ <code>${fmtPrice(p.low, p.decimals)}</code>`,
      `  Whale Δ reserveA ≥ <b>${p.whalePct}%</b>`,
      `  Last: <code>${s.lastPrice ? fmtPrice(s.lastPrice, p.decimals) : 'N/A'}</code> (zone: <b>${s.zone}</b>)`,
      s.activeWhale
        ? `  🐋 Active ${s.activeWhale.kind} since <code>${s.activeWhale.startedAt}</code>`
        : '',
      ''
    );
  }
  return lines.filter(Boolean).join('\n');
}

export async function buildQuoteReply(pairKey, inputToken, inputAmount) {
  const p = cfg.pairs.find((x) => x.key === pairKey);
  if (!p) return '⚠️ Pair tidak dikenal';
  try {
    const q = await fetchQuote(p.poolId, inputToken, inputAmount);
    const outDecimals = q.outputToken?.id === 'CBTC' ? 8 : q.outputToken?.id === 'CC' ? 4 : 4;
    const inDecimals = inputToken === 'CBTC' ? 8 : inputToken === 'CC' ? 2 : 4;
    return [
      `📋 <b>Quote — ${p.label}</b>`,
      ``,
      `IN:  <code>${Number(q.inputAmount).toFixed(inDecimals)}</code> ${q.inputToken?.id || inputToken}`,
      `OUT: <code>${Number(q.outputAmount).toFixed(outDecimals)}</code> ${q.outputToken?.id || '?'}`,
      ``,
      `Effective price: <code>${q.effectivePrice}</code>`,
      `Price impact:    <b>${q.priceImpact}%</b>${q.exceededMaxImpact ? ' ⚠️ EXCEEDED MAX' : ''}`,
      `LP fee:       ${Number(q.lpFeeAmount || 0).toFixed(4)} ${q.inputToken?.id || inputToken}`,
      `Platform fee: ${Number(q.platformFeeAmount || 0).toFixed(4)} ${q.inputToken?.id || inputToken}`,
      `Network fee:  ${Number(q.networkFeeAmount || 0).toFixed(4)} ${q.inputToken?.id || inputToken}`,
      ``,
      `<i>${new Date().toISOString()} — read-only, eksekusi manual via app</i>`,
    ].join('\n');
  } catch (e) {
    return `⚠️ Quote failed: ${e.message?.slice(0, 200)}\nResponse: ${JSON.stringify(e.response?.data || e.body || {}).slice(0, 200)}`;
  }
}

// ---------- Alert senders ----------
export async function sendWhaleAlert(p, d, w, alert) {
  const emoji = alert.kind === 'dump' ? '🐋📉' : '🐋📈';
  const word = alert.kind === 'dump' ? 'DUMP' : 'PUMP';
  const verb = alert.kind === 'dump' ? 'JUAL' : 'BELI';
  const sizeA = Math.abs(alert.deltaA);
  const sizeB = Math.abs(alert.deltaB);
  const direction = alert.kind === 'dump' ? 'BUY ZONE 💡' : 'SELL ZONE 💡';
  const lines = [
    `${emoji} <b>${p.label} — WHALE ${word}!</b>`,
    ``,
    `${verb}: ~<code>${alert.kind === 'dump' ? sizeA.toFixed(2) + ' CC' : sizeB.toFixed(p.reserveBDecimals) + ' ' + p.quote}</code>`,
    `Got back: ~<code>${alert.kind === 'dump' ? sizeB.toFixed(p.reserveBDecimals) + ' ' + p.quote : sizeA.toFixed(2) + ' CC'}</code>`,
    `Reserve Δ: <b>${alert.pctA.toFixed(2)}%</b> reserveA`,
    `Price: <code>${fmtPrice(w.startPrice, p.decimals)}</code> → <code>${fmtPrice(d.price, p.decimals)}</code> (${pctChange(w.startPrice, d.price).toFixed(2)}%)`,
    ``,
    `🎯 <b>${direction}</b>`,
    `<i>${new Date().toISOString()}</i>`,
  ];
  await tgSend(lines.join('\n'));
}

export async function sendReboundAlert(p, d, ev) {
  const w = ev.prev;
  const elapsedStr = durationStr(ev.elapsedMs);
  const totalMove = Math.abs(w.startPrice - w.extremePrice);
  const recovered = w.kind === 'dump' ? d.price - w.extremePrice : w.extremePrice - d.price;
  const recoverPct = totalMove > 0 ? (recovered / totalMove) * 100 : 0;

  let header;
  if (ev.expired) header = `⌛ <b>${p.label} — Whale window expired</b>`;
  else if (ev.forced) header = `🔄 <b>${p.label} — Direction flip</b>`;
  else header = `✅ <b>${p.label} — REBOUND</b>`;

  const lines = [
    header,
    ``,
    `Direction: <b>${w.kind.toUpperCase()}</b>`,
    `Price: <code>${fmtPrice(w.startPrice, p.decimals)}</code> → <code>${fmtPrice(w.extremePrice, p.decimals)}</code> → <code>${fmtPrice(d.price, p.decimals)}</code>`,
    `Recovery: <b>${recoverPct.toFixed(1)}%</b>  Window: <b>${elapsedStr}</b>`,
    ``,
  ];
  if (w.kind === 'dump' && d.price > w.extremePrice) {
    const gain = pctChange(w.extremePrice, d.price);
    lines.push(`💡 Kalau bos beli @ <code>${fmtPrice(w.extremePrice, p.decimals)}</code> dan jual sekarang: <b>+${gain.toFixed(2)}%</b> gross`);
  } else if (w.kind === 'pump' && d.price < w.extremePrice) {
    const gain = pctChange(d.price, w.extremePrice);
    lines.push(`💡 Kalau bos jual @ <code>${fmtPrice(w.extremePrice, p.decimals)}</code> dan beli back sekarang: <b>+${gain.toFixed(2)}%</b> gross`);
  }
  lines.push(`<i>${new Date().toISOString()}</i>`);
  await tgSend(lines.join('\n'));
}

export async function sendZoneAlert(p, d, prevPrice, alert) {
  const emoji = alert.kind === 'high' ? '🚀' : '⚠️';
  const word = alert.kind === 'high' ? 'NAIK ke' : 'TURUN ke';
  const threshold = alert.kind === 'high' ? p.high : p.low;
  const liq = `${d.reserveA.toFixed(0)} ${d.tokenA} / ${d.reserveB.toFixed(p.reserveBDecimals)} ${d.tokenB}`;
  const lines = [
    `${emoji} <b>${p.label} ${word} threshold!</b>`,
    ``,
    `Price: <code>${fmtPrice(d.price, p.decimals)}</code>`,
    `Threshold ${alert.kind.toUpperCase()}: <code>${fmtPrice(threshold, p.decimals)}</code>`,
    prevPrice ? `Prev: <code>${fmtPrice(prevPrice, p.decimals)}</code> (Δ ${pctChange(prevPrice, d.price).toFixed(2)}%)` : '',
    ``,
    `Liq: ${liq}`,
    `<i>${new Date().toISOString()}</i>`,
  ].filter(Boolean);
  await tgSend(lines.join('\n'));
}

export async function sendStartupMessage() {
  await tgSend(
    [
      '🟢 <b>OneSwap Monitor v2 started</b>',
      `Mode: ${oneswap ? '🔐 authenticated' : '👁 read-only'}`,
      `Poll: <b>${cfg.pollSec}s</b>  Rebound watch: <b>${cfg.reboundMin}m</b>`,
      `Pairs: <b>${cfg.pairs.map((p) => p.label).join(', ')}</b>`,
      '',
      '<b>Auto-alerts aktif:</b>',
      ...cfg.pairs.map((p) =>
        `• ${p.label}: range <code>${fmtPrice(p.low, p.decimals)}</code>↔<code>${fmtPrice(p.high, p.decimals)}</code> | whale Δ ≥ <b>${p.whalePct}%</b>`
      ),
      '',
      'Tombol persistent di bawah → quick quote.',
    ].join('\n'),
    { reply_markup: persistentReplyKeyboard() }
  );
}

// ---------- Telegram poll ----------
let updateOffset = 0;

async function sendHelp() {
  return await tgSend(
    [
      '🤖 <b>OneSwap Price Monitor v2</b>',
      '',
      '<b>Commands:</b>',
      '/price — cek harga semua pair',
      '/status — threshold + state monitor',
      '/quote &lt;TOKEN&gt; &lt;AMOUNT&gt; — quote read-only',
      '/help — pesan ini',
      '',
      '<b>Auto alert:</b>',
      '🐋 Whale dump/pump (delta reserve > threshold)',
      '✅ Rebound (price recover ≥ ' + cfg.reboundPct + '%)',
      '🚀 / ⚠️ Threshold cross (low/high range)',
      '',
      `<b>Auth:</b> ${oneswap ? '🔐 Authenticated (challenge→sign→verify)' : '👁 Read-only (no keys configured)'}`,
      '',
      'Quote read-only — eksekusi swap manual via app.',
    ].join('\n'),
    { reply_markup: persistentReplyKeyboard() }
  );
}

async function handleUpdate(u) {
  // Callback button
  if (u.callback_query) {
    const cq = u.callback_query;
    const data = cq.data || '';
    if (data === 'check_price') {
      await tgAnswerCallback(cq.id, '⏳ Mengambil harga...');
      await tgSend(await buildPriceReport());
    } else if (data === 'check_status') {
      await tgAnswerCallback(cq.id);
      await tgSend(await buildStatusReport());
    } else if (data.startsWith('q|')) {
      const [, pairKey, inputToken, amtStr] = data.split('|');
      await tgAnswerCallback(cq.id, `⏳ Quote ${amtStr} ${inputToken}...`);
      await tgSend(await buildQuoteReply(pairKey, inputToken, Number(amtStr)));
    } else {
      await tgAnswerCallback(cq.id);
    }
    return;
  }

  if (u.message?.text) {
    const text = u.message.text.trim();
    const lower = text.toLowerCase();
    const fromChat = String(u.message.chat?.id) === String(cfg.tgChat);
    if (!fromChat) return;

    // Persistent reply-keyboard shortcuts
    const buyMatch = text.match(/^💰\s*BUY\s+([\d.]+)\s*(USDCx|USDC)/i);
    const sellMatch = text.match(/^(?:📤|💸)\s*SELL\s+([\d.]+)\s*CC$/i);
    const cbtcMatch = text.match(/^🪙\s*BUY\s+([\d.]+)\s*CBTC$/i);
    if (buyMatch) {
      await tgSend(await buildQuoteReply('CC_USDCX', 'USDCx', Number(buyMatch[1])));
      return;
    }
    if (sellMatch) {
      await tgSend(await buildQuoteReply('CC_USDCX', 'CC', Number(sellMatch[1])));
      return;
    }
    if (cbtcMatch) {
      await tgSend(await buildQuoteReply('CC_CBTC', 'CBTC', Number(cbtcMatch[1])));
      return;
    }
    if (text === '📊 Price' || lower === 'price') {
      await tgSend(await buildPriceReport());
      return;
    }
    if (text === '🛟 Status' || lower === 'status') {
      await tgSend(await buildStatusReport());
      return;
    }
    if (text === '❓ Help' || lower === 'help') {
      await sendHelp();
      return;
    }

    // Slash commands
    if (lower === '/price' || lower.startsWith('/price@') || lower.startsWith('/price ')) {
      await tgSend(await buildPriceReport());
    } else if (lower === '/status' || lower.startsWith('/status@')) {
      await tgSend(await buildStatusReport());
    } else if (lower.startsWith('/quote')) {
      const parts = text.split(/\s+/);
      const inputToken = parts[1];
      const amount = Number(parts[2]);
      const pairKey = parts[3] ? parts[3].toUpperCase() : (inputToken === 'CBTC' ? 'CC_CBTC' : 'CC_USDCX');
      if (!inputToken || !isFinite(amount) || amount <= 0) {
        await tgSend('Format: <code>/quote &lt;TOKEN&gt; &lt;AMOUNT&gt; [PAIR]</code>\n' +
          'Contoh:\n<code>/quote CC 500</code> → quote 500 CC ke USDCx\n' +
          '<code>/quote USDCx 100</code> → quote 100 USDCx ke CC\n' +
          '<code>/quote CC 500 CC_CBTC</code> → quote 500 CC ke CBTC');
        return;
      }
      await tgSend(await buildQuoteReply(pairKey, inputToken, amount));
    } else if (lower === '/help' || lower === '/start' || lower.startsWith('/start ')) {
      await sendHelp();
    }
  }
}

export async function pollTelegramUpdates(_tickFn) {
  while (true) {
    try {
      const res = await fetch(`${tgApi}/getUpdates?offset=${updateOffset}&timeout=25`, {
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();
      const updates = data?.result || [];
      for (const u of updates) {
        updateOffset = u.update_id + 1;
        await handleUpdate(u);
      }
    } catch (e) {
      log('warn', `getUpdates: ${e.message?.slice(0, 150)}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
