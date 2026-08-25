// Weighted-average cost basis for a single wallet's trade history.
//
// Pure — no network, no DOM. Same function feeds the live "paste a wallet" replay in the
// browser and the bulk leaderboard build in tools/build-traders.js, so the number on the
// chart and the number in the ranking can't drift apart.
//
// WHY WEIGHTED-AVERAGE, NOT FIFO: every pnl card in the space quotes weighted-average, so
// FIFO would make us the odd one out and invite "your number is wrong" replies. FIFO also
// needs per-lot bookkeeping that a partial trade history quietly corrupts anyway.
//
// THE HONESTY PROBLEM: Jupiter's feed only knows about routed swaps. Airdrops, direct
// transfers and non-Jupiter fills are invisible, so a wallet can appear to sell tokens it
// never appears to have bought. We don't paper over that — sells beyond the tracked
// position are clamped and counted in `flags.phantomTokens`. Any caller showing a total
// must check `flags.partial` first.

function computePnl(trades, price) {
  const rows = (trades || [])
    .filter(t => t && (t.type === 'buy' || t.type === 'sell'))
    .map(t => ({
      type: t.type,
      ts: Date.parse(t.timestamp),
      amount: Math.abs(+t.amount || 0),
      usd: Math.abs(+t.usdVolume || 0),
      px: +t.usdPrice || 0,
      hash: t.txHash,
      badPrice: t.isValidPrice === false,
    }))
    .filter(t => t.amount > 0 && Number.isFinite(t.ts))
    .sort((a, b) => a.ts - b.ts || (a.type === 'buy' ? -1 : 1));

  let pos = 0, basis = 0;              // tokens held, USD cost of that position
  let bought = 0, sold = 0, realized = 0;
  let buyTokens = 0, buyUsd = 0;       // lifetime, for avg entry when flat
  let phantom = 0, badPrice = 0;
  const marks = [];

  for (const t of rows) {
    if (t.badPrice) badPrice++;

    if (t.type === 'buy') {
      pos += t.amount; basis += t.usd;
      bought += t.usd; buyTokens += t.amount; buyUsd += t.usd;
      marks.push({ ts: t.ts, type: 'buy', usd: t.usd, amount: t.amount, px: t.px, hash: t.hash });
    } else {
      // clamp: you cannot sell what we never saw you get. the excess is real on-chain but
      // its cost basis is unknowable, so it earns no realized pnl rather than a fake one.
      const qty = Math.min(t.amount, pos);
      if (t.amount - qty > 1e-9) phantom += t.amount - qty;

      const share = qty / t.amount;              // proceeds attributable to tracked tokens
      const avg = pos > 0 ? basis / pos : 0;
      const proceeds = t.usd * share;

      realized += proceeds - avg * qty;
      basis -= avg * qty;
      pos -= qty;
      sold += t.usd;
      marks.push({ ts: t.ts, type: 'sell', usd: t.usd, amount: t.amount, px: t.px, hash: t.hash });
    }
    if (pos < 1e-9) { pos = 0; basis = 0; }      // flat resets basis; float dust doesn't linger
  }

  const p = +price || 0;
  const holding = pos * p;
  const unrealized = pos > 0 ? holding - basis : 0;

  return {
    trades: rows.length,
    buys: rows.filter(t => t.type === 'buy').length,
    sells: rows.filter(t => t.type === 'sell').length,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: rows.length ? rows[rows.length - 1].ts : null,
    bought, sold, realized, unrealized,
    total: realized + unrealized,
    position: pos,
    holding,
    costBasis: basis,
    avgEntry: pos > 0 ? basis / pos : (buyTokens > 0 ? buyUsd / buyTokens : 0),
    marks,
    flags: {
      partial: phantom > 0,
      phantomTokens: phantom,
      badPriceTrades: badPrice,
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { computePnl };
else if (typeof window !== 'undefined') window.computePnl = computePnl;
