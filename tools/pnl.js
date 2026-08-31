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
  let soldTokens = 0;                  // tracked tokens out — phantom sells excluded
  let redBuyUsd = 0;                   // dollars deployed BELOW the running average entry
  let phantom = 0, badPrice = 0;
  const marks = [];

  for (const t of rows) {
    if (t.badPrice) badPrice++;

    if (t.type === 'buy') {
      // averaging down: priced below your own basis at the moment you pressed buy. measured
      // before the fill lands, or the new tokens move the average you're being compared to.
      if (pos > 0 && t.px > 0 && t.px < basis / pos) redBuyUsd += t.usd;
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
      sold += t.usd; soldTokens += qty;
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
    // ---- conviction inputs. TOKEN-weighted on purpose: sold/bought in DOLLARS is contaminated
    // by price, so a wallet that 10x'd and sold half its bag reads 5.0 and grades as a jeet
    // while it still holds half. Tokens can't do that.
    boughtTokens: buyTokens,
    soldTokens,
    sellRatio: buyTokens > 0 ? Math.min(1, soldTokens / buyTokens) : 0,
    redBuyUsd,
    addRatio: bought > 0 ? redBuyUsd / bought : 0,
    flags: {
      partial: phantom > 0,
      phantomTokens: phantom,
      badPriceTrades: badPrice,
    },
  };
}


// ---- the grade -------------------------------------------------------------------------
// Graded on CONVICTION, not pnl. The card already screams the dollars and the multiple in
// 34px type — a rank that restates them carries no new information. What the number can't
// say is whether the wallet held, and whether it kept buying while it was red. That's the
// part worth a letter.
//
// Bands are TOKEN-weighted (see sellRatio). Never-sold splits in two: sitting on a bag is
// not the same act as adding to one that's underwater, so S needs both.
const CONVICTION_TIERS = [
  [0.25, 'B', 'MOSTLY BELIEVING'],
  [0.50, 'C', 'STOP TRADING START BELIEVING'],
  [0.75, 'D', 'JEET'],
  [0.999, 'F', 'SUPER JEET'],
  [Infinity, 'F', 'GIGA JEET'],
];

function convictionRank(p) {
  const mult = p.bought > 0 ? (p.sold + p.holding) / p.bought : 0;
  const base = { mult, sellRatio: p.sellRatio || 0, addRatio: p.addRatio || 0 };

  // sells we never saw acquired pin sellRatio to 1.0 — that is missing data, not a full exit,
  // and calling it GIGA JEET would be the tool lying with total confidence.
  if (p.flags && p.flags.partial) return { ...base, rank: '?', label: 'UNSCOREABLE' };

  if (base.sellRatio <= 0) {
    // a single buy held is a position. three buys with a quarter of the capital deployed
    // below your own entry is a decision, repeated, while losing.
    return base.addRatio >= 0.25 && p.buys >= 3
      ? { ...base, rank: 'S', label: 'BALLS OF STEEL' }
      : { ...base, rank: 'A', label: 'NEVER SOLD' };
  }
  for (const [m, rank, label] of CONVICTION_TIERS) {
    if (base.sellRatio <= m) return { ...base, rank, label };
  }
  return { ...base, rank: 'F', label: 'GIGA JEET' };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { computePnl, convictionRank };
else if (typeof window !== 'undefined') { window.computePnl = computePnl; window.convictionRank = convictionRank; }
