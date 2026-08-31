#!/usr/bin/env node
// Hand-computed fixtures for tools/pnl.js. Every expected number below was worked out on
// paper first, not copied from a run — otherwise this suite just certifies whatever the
// code already does.
//
//   node test/pnl-math.js            run the suite
//   node test/pnl-math.js --canary   corrupt the reducer and prove the suite goes RED
//
// The canary exists because a green test that cannot fail is worth nothing.

const path = require('path');
const { computePnl, convictionRank } = require(path.join(__dirname, '..', 'tools', 'pnl.js'));

const CANARY = process.argv.includes('--canary');
let pass = 0, fail = 0;

const tx = (type, amount, usd, min) => ({
  type, amount, usdVolume: usd, usdPrice: usd / amount,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(),
  txHash: type + min,
});

function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

function check(label, actual, expected) {
  // the canary shifts every observed value by 1, so a suite that actually compares
  // things must report failures. if it still passes, the assertions are vacuous.
  const got = CANARY && typeof actual === 'number' ? actual + 1 : actual;
  const ok = typeof expected === 'number' ? near(got, expected) : got === expected;
  if (ok) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${got}, expected ${expected}`); }
}

// --- 1. round trip -------------------------------------------------------------
// buy 1000 tok for $100 => avg $0.10. sell 500 for $100 => cost of those 500 is $50,
// so realized = 100 - 50 = $50. left holding 500 tok at basis $50.
// mark price $0.30 => holding $150, unrealized 150 - 50 = $100. total $150.
{
  const r = computePnl([tx('buy', 1000, 100, 0), tx('sell', 500, 100, 5)], 0.30);
  console.log('1. round trip');
  check('realized', r.realized, 50);
  check('position', r.position, 500);
  check('costBasis', r.costBasis, 50);
  check('holding', r.holding, 150);
  check('unrealized', r.unrealized, 100);
  check('total', r.total, 150);
  check('avgEntry', r.avgEntry, 0.10);
  check('partial', r.flags.partial, false);
}

// --- 2. weighted average across two entries -------------------------------------
// buy 1000 @ $100 and 1000 @ $300 => 2000 tok, basis $400, avg $0.20.
// sell 1000 for $500 => cost 0.20*1000 = $200, realized = 500 - 200 = $300.
{
  const r = computePnl([tx('buy', 1000, 100, 0), tx('buy', 1000, 300, 5), tx('sell', 1000, 500, 10)], 0.50);
  console.log('2. weighted average');
  check('avg used', r.realized, 300);
  check('position', r.position, 1000);
  check('costBasis', r.costBasis, 200);
  check('bought', r.bought, 400);
  check('sold', r.sold, 500);
}

// --- 3. phantom sell (airdrop / transfer-in Jupiter never saw) --------------------
// selling 1000 tok with no recorded buy must NOT invent $1000 of profit.
{
  const r = computePnl([tx('sell', 1000, 1000, 0)], 0.50);
  console.log('3. phantom sell');
  check('realized stays 0', r.realized, 0);
  check('position floors at 0', r.position, 0);
  check('flagged partial', r.flags.partial, true);
  check('phantom tokens', r.flags.phantomTokens, 1000);
}

// --- 4. full exit --------------------------------------------------------------
// bought and fully sold: unrealized must be 0 no matter what price we mark at.
{
  const r = computePnl([tx('buy', 1000, 100, 0), tx('sell', 1000, 250, 5)], 99);
  console.log('4. full exit');
  check('realized', r.realized, 150);
  check('unrealized', r.unrealized, 0);
  check('holding', r.holding, 0);
  check('total', r.total, 150);
}

// --- 5. out-of-order input ------------------------------------------------------
// the feed pages newest-first; the reducer must sort or the sell gets clamped to 0.
{
  const r = computePnl([tx('sell', 500, 100, 5), tx('buy', 1000, 100, 0)], 0.30);
  console.log('5. reverse-chronological input');
  check('realized', r.realized, 50);
  check('not flagged partial', r.flags.partial, false);
}


// --- 6. conviction grade --------------------------------------------------------
// Hand-worked. tx() prices each fill at usd/amount, so the entry price is explicit below.
// The ladder is TOKEN-weighted: case 6d is the one that catches a dollar-weighted grader,
// which would score a wallet up 5x on half its bag as a jeet.
{
  console.log('6. conviction grade');

  // 3 buys at 0.10 → 0.05 → 0.025, never sold. $75 of the $175 in went below the running
  // average (100/1000 = 0.10 before buy 2; 150/3000 = 0.05 before buy 3), so addRatio = 75/175.
  const steel = convictionRank(computePnl(
    [tx('buy', 1000, 100, 0), tx('buy', 1000, 50, 5), tx('buy', 1000, 25, 10)], 0.02));
  check('6a rank', steel.rank, 'S');
  check('6a label', steel.label, 'BALLS OF STEEL');
  check('6a sellRatio', steel.sellRatio, 0);
  check('6a addRatio', steel.addRatio, 75 / 175);

  // same bag, one buy. held, but never decided anything twice.
  const held = convictionRank(computePnl([tx('buy', 1000, 100, 0)], 0.02));
  check('6b rank', held.rank, 'A');
  check('6b label', held.label, 'NEVER SOLD');

  // 500 of 1000 tokens out = exactly the 0.50 band edge
  const half = convictionRank(computePnl([tx('buy', 1000, 100, 0), tx('sell', 500, 90, 5)], 0.15));
  check('6c sellRatio', half.sellRatio, 0.5);
  check('6c label', half.label, 'STOP TRADING START BELIEVING');

  // THE TOKEN-WEIGHTING TEST: in dollars this is 500 sold on 100 in = 5.0, which any
  // dollar-weighted ladder grades GIGA JEET. In tokens it is half the bag, still holding.
  const winner = convictionRank(computePnl([tx('buy', 1000, 100, 0), tx('sell', 500, 500, 5)], 1.0));
  check('6d mult', winner.mult, 10);
  check('6d sellRatio', winner.sellRatio, 0.5);
  check('6d not a jeet', winner.label, 'STOP TRADING START BELIEVING');

  // 800/1000 out
  const jeet = convictionRank(computePnl([tx('buy', 1000, 100, 0), tx('sell', 800, 200, 5)], 0.25));
  check('6e sellRatio', jeet.sellRatio, 0.8);
  check('6e label', jeet.label, 'SUPER JEET');

  const gone = convictionRank(computePnl([tx('buy', 1000, 100, 0), tx('sell', 1000, 250, 5)], 0.25));
  check('6f sellRatio', gone.sellRatio, 1);
  check('6f label', gone.label, 'GIGA JEET');

  // a sell we never saw acquired clamps sellRatio to 1.0. that is missing history, and
  // grading it GIGA JEET would be the tool asserting something it cannot know.
  const partial = convictionRank(computePnl([tx('sell', 1000, 250, 5)], 0.25));
  check('6g rank', partial.rank, '?');
  check('6g label', partial.label, 'UNSCOREABLE');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (CANARY) {
  if (fail > 0) { console.log('CANARY OK — the suite reports failures when values are wrong.'); process.exit(0); }
  console.log('CANARY FAILED — assertions are vacuous, they pass on corrupted values.');
  process.exit(1);
}
process.exit(fail ? 1 : 0);
