#!/usr/bin/env node
// Reconstruct the dormancy timeline across $ALON's whole life.
//
// Dormancy is defined by the ABSENCE of transactions, so it's recoverable from the chain —
// no need to have been watching. Pull every signature for every holder, then sweep forward
// day by day asking "how many wallets hadn't moved in 7/14/30 days as of this date".
//
// ⚠ SURVIVORSHIP: this walks accounts that exist NOW. Anyone who bought, sold out and closed
// their token account is absent, so the output is "how today's holders behaved historically",
// NOT a census of who held back then. Labelling it as the latter overstates conviction badly —
// the 2025 figures come out at 97-99% precisely because the sellers aren't in the denominator.
// `holders` here is an arrival curve for today's cohort, not a historical holder count.
//
// Wallet-count weighted. Supply weighting is also affordable (~161k getTransaction calls,
// ~16% of a free month — median holder has just 2 txs), but it's hours of wall clock, so it's
// a separate deliberate run rather than something bolted onto this one.
//
//   HELIUS_KEY=... node tools/backfill-history.js
//
// Resumable: signature pages are checkpointed, so a kill costs you nothing.

const fs = require('fs'), path = require('path');
const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
const DIR = path.join(__dirname, '..', 'holders');
const KEY = process.env.HELIUS_KEY;
if (!KEY) { console.error('HELIUS_KEY required'); process.exit(1); }
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const CONC = 10, DAY = 86400;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(method, params, tries = 5) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch (e) { await sleep(a * 2000); continue; }
      if (j.error) { await sleep(a * 2000); continue; }
      return j.result;
    } catch (e) { await sleep(a * 2000); }
  }
  return null;
}

(async () => {
  const accounts = JSON.parse(fs.readFileSync(path.join(DIR, 'snap-' +
    fs.readdirSync(DIR).filter(f => f.startsWith('snap-')).sort().pop().slice(5)), 'utf8'));
  const list = Object.keys(accounts);
  console.error(`${list.length} accounts to walk`);

  // per wallet: the distinct DAYS it was ever active. days, not timestamps — 610 txs collapse
  // to far fewer days, and days are all the sweep needs.
  const ckpt = path.join(DIR, 'daymap.json');
  const dayMap = fs.existsSync(ckpt) ? JSON.parse(fs.readFileSync(ckpt, 'utf8')) : {};
  const todo = list.filter(a => !(a in dayMap));
  console.error(`${list.length - todo.length} cached, ${todo.length} to fetch`);

  let i = 0, done = 0, sigs = 0, t0 = Date.now();
  async function worker() {
    while (i < todo.length) {
      const acct = todo[i++];
      const days = new Set();
      let before = null;
      for (let page = 0; page < 30; page++) {          // 30k signature ceiling per wallet
        const s = await rpc('getSignaturesForAddress', [acct, before ? { limit: 1000, before } : { limit: 1000 }]);
        if (!s || !s.length) break;
        sigs += s.length;
        for (const x of s) if (x.blockTime) days.add(Math.floor(x.blockTime / DAY));
        if (s.length < 1000) break;
        before = s[s.length - 1].signature;
      }
      dayMap[acct] = [...days].sort((a, b) => a - b);
      if (++done % 200 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        process.stderr.write(`\r  ${done}/${todo.length}  ${rate.toFixed(1)} wallets/s  ${(sigs/1e6).toFixed(2)}M sigs  eta ${Math.round((todo.length-done)/rate/60)}m   `);
        fs.writeFileSync(ckpt, JSON.stringify(dayMap));
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  fs.writeFileSync(ckpt, JSON.stringify(dayMap));
  console.error(`\nfetched. ${(sigs/1e6).toFixed(2)}M signatures across ${list.length} wallets`);

  // sweep: for every day, how many wallets that existed by then hadn't moved in 7/14/30d
  const all = Object.values(dayMap).filter(d => d.length);
  const first = Math.min(...all.map(d => d[0]));
  const last = Math.floor(Date.now() / 1000 / DAY);
  const cursor = new Array(all.length).fill(0);        // per-wallet pointer into its day list
  const lastSeen = new Array(all.length).fill(-1);
  const out = [];
  for (let d = first; d <= last; d++) {
    let born = 0, b7 = 0, b14 = 0, b30 = 0;
    for (let w = 0; w < all.length; w++) {
      const days = all[w];
      while (cursor[w] < days.length && days[cursor[w]] <= d) lastSeen[w] = days[cursor[w]++];
      if (lastSeen[w] < 0) continue;                    // wallet didn't exist yet on this date
      born++;
      const age = d - lastSeen[w];
      if (age >= 7) b7++;
      if (age >= 14) b14++;
      if (age >= 30) b30++;
    }
    out.push({ d: new Date(d * DAY * 1000).toISOString().slice(0, 10), cohort: born,
               d7: +(b7 / born * 100).toFixed(2), d14: +(b14 / born * 100).toFixed(2),
               d30: +(b30 / born * 100).toFixed(2) });
  }
  fs.writeFileSync(path.join(DIR, 'lifespan.json'), JSON.stringify(out));
  console.error(`wrote ${out.length} days: ${out[0].d} -> ${out[out.length-1].d}`);
  console.error(`latest: ${JSON.stringify(out[out.length-1])}`);
})();
