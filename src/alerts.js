// Alert detection: whale, zone threshold, rebound tracking

// ---------- Zone-based threshold alert ----------
export function checkAlertZone(p, price, s) {
  const now = Date.now();
  let newZone = s.zone;
  if (price >= p.high) newZone = 'high';
  else if (price <= p.low) newZone = 'low';
  else newZone = 'normal';

  let alert = null;
  if (newZone !== s.zone && (newZone === 'high' || newZone === 'low')) {
    const elapsed = now - s.lastAlertAt;
    if (elapsed >= (typeof p._rearmSec === 'number' ? p._rearmSec : 900) * 1000 || s.lastAlertAt === 0) {
      alert = { kind: newZone, from: s.zone, to: newZone };
      s.lastAlertAt = now;
    }
  }
  s.zone = newZone;
  return alert;
}

// ---------- Whale detect ----------
export function detectWhale(p, d, s) {
  if (s.lastReserveA === null) return null;
  const deltaA = d.reserveA - s.lastReserveA;
  const pctA = (Math.abs(deltaA) / s.lastReserveA) * 100;
  if (pctA < p.whalePct) return null;

  // dump = reserveA naik (someone added CC, sold CC for quote)
  // pump = reserveA turun (someone took CC, bought CC with quote)
  return {
    kind: deltaA > 0 ? 'dump' : 'pump',
    deltaA,
    deltaB: d.reserveB - s.lastReserveB,
    pctA,
  };
}

// ---------- Whale + Rebound handler ----------
export function handleWhaleAndRebound(p, d, s, whale, prevPrice) {
  const out = { whaleAlert: null, reboundAlert: null };
  const now = Date.now();

  // 1) New whale event
  if (whale) {
    if (!s.activeWhale) {
      s.activeWhale = {
        kind: whale.kind,
        startedAt: new Date(now).toISOString(),
        startedAtMs: now,
        startPrice: prevPrice,
        extremePrice: d.price,
        startReserveA: s.lastReserveA,
        startReserveB: s.lastReserveB,
        cumulativeDeltaA: whale.deltaA,
        cumulativeDeltaB: whale.deltaB,
      };
      out.whaleAlert = { fresh: true, kind: whale.kind, deltaA: whale.deltaA, deltaB: whale.deltaB, pctA: whale.pctA };
    } else if (s.activeWhale.kind === whale.kind) {
      // Back-to-back same direction → extend (dampen spam)
      s.activeWhale.cumulativeDeltaA += whale.deltaA;
      s.activeWhale.cumulativeDeltaB += whale.deltaB;
      if (whale.kind === 'dump' && d.price < s.activeWhale.extremePrice) s.activeWhale.extremePrice = d.price;
      if (whale.kind === 'pump' && d.price > s.activeWhale.extremePrice) s.activeWhale.extremePrice = d.price;
    } else {
      // Direction change: close existing + start new
      out.reboundAlert = {
        forced: true,
        prev: s.activeWhale,
        finalPrice: d.price,
        elapsedMs: now - s.activeWhale.startedAtMs,
      };
      s.activeWhale = {
        kind: whale.kind,
        startedAt: new Date(now).toISOString(),
        startedAtMs: now,
        startPrice: prevPrice,
        extremePrice: d.price,
        startReserveA: s.lastReserveA,
        startReserveB: s.lastReserveB,
        cumulativeDeltaA: whale.deltaA,
        cumulativeDeltaB: whale.deltaB,
      };
      out.whaleAlert = { fresh: true, kind: whale.kind, deltaA: whale.deltaA, deltaB: whale.deltaB, pctA: whale.pctA };
    }
  }

  // 2) Rebound check on active event (no new whale this tick)
  if (!whale && s.activeWhale) {
    const w = s.activeWhale;
    const elapsedMs = now - w.startedAtMs;
    const totalMove = Math.abs(w.startPrice - w.extremePrice);
    const recoverNow = w.kind === 'dump' ? d.price - w.extremePrice : w.extremePrice - d.price;
    const recoverPct = totalMove > 0 ? (recoverNow / totalMove) * 100 : 0;
    // Update extreme if moved further
    if (w.kind === 'dump' && d.price < w.extremePrice) w.extremePrice = d.price;
    if (w.kind === 'pump' && d.price > w.extremePrice) w.extremePrice = d.price;

    const reboundMin = p._reboundMin || 15;
    if (recoverPct >= (p._reboundPct || 80)) {
      out.reboundAlert = { prev: { ...w }, finalPrice: d.price, recoverPct, elapsedMs };
      s.activeWhale = null;
    } else if (elapsedMs > reboundMin * 60 * 1000) {
      out.reboundAlert = { expired: true, prev: { ...w }, finalPrice: d.price, recoverPct, elapsedMs };
      s.activeWhale = null;
    }
  }

  return out;
}
