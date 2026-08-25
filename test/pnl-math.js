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
const { computePnl } = require(path.join(__dirname, '..', 'tools', 'pnl.js'));

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

console.log(`\n${pass} passed, ${fail} failed`);
if (CANARY) {
  if (fail > 0) { console.log('CANARY OK — the suite reports failures when values are wrong.'); process.exit(0); }
  console.log('CANARY FAILED — assertions are vacuous, they pass on corrupted values.');
  process.exit(1);
}
process.exit(fail ? 1 : 0);
