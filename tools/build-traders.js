#!/usr/bin/env node
// Builds holders/traders.json — the $ALON trader leaderboard behind the wallet replay.
//
//   node tools/build-traders.js --days=7           walk back 7 days of trades
//   node tools/build-traders.js --days=7 --names   also resolve pump.fun usernames
//   node tools/build-traders.js --resume           continue from the last checkpoint
//
// WHY A FULL-FEED WALK, NOT PER-WALLET QUERIES: datapi.jup.ag/v1/txs takes a
// traderAddress filter, but you'd need to know the wallets first. One unfiltered walk
// yields every trader in the window at the same cost as querying a single one. The live
// site still uses the FILTERED endpoint — that's the paste-a-wallet path, which must be
// instant and can't wait on a walk.
//
// THE CEILING IS REAL: limit caps at 30 regardless of what you ask for (limit=1000 still
// returns 30), and the cursor walk is strictly serial, so throughput is ~40 pages/30s.
// A window is not optional at $ALON's lifetime volume. Coverage is written into the
// output so the site can state the window instead of implying "all time".
//
// pump.fun's API 403s any browser Origin, but Node sends none — so name resolution can
// only happen HERE, baked into the static file. Do not try it from the page.

const fs = require('fs'), path = require('path');
const { computePnl } = require('./pnl.js');

const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
const DIR = path.join(__dirname, '..', 'holders');
const OUT = path.join(DIR, 'traders.json');
const CKPT = path.join(DIR, '.traders-ckpt.json');

const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1];
const has = k => process.argv.includes('--' + k);

const DAYS = +(arg('days') || 7);
const MAXPAGES = +(arg('max-pages') || 4000);
const NAMES = has('names');
const RESUME = has('resume');
const DEEP = has('deep');
const DEEP_MAXPG = +(arg('deep-max-pages') || 25);   // a bot can have thousands of trades
const MIN_USD = +(arg('min-usd') || 250);   // ignore dust wallets; they bloat the file, not the story
const KEEP_PARTIAL = has('include-partial');

// A wallet that bought before the window opened shows sells with no basis, so its pnl is
// unknowable — not zero, UNKNOWABLE. Measured on a 3.6h window: 34 of 70 wallets, 28 of
// them sell-only. Ranking those next to complete histories invents a leaderboard, so they
// are written to the file (the replay still wants their trades) but excluded from `traders`
// unless --include-partial. The fix for a thin leaderboard is a deeper --days, not this flag.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 4) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(a * 2500); continue; }
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return await r.json();
    } catch (e) {
      if (a === tries) throw e;
      await sleep(a * 1200);
    }
  }
}

// ---- walk the feed ------------------------------------------------------------
async function walk() {
  const cutoff = Date.now() - DAYS * 864e5;
  let cursor = null, pages = 0, kept = 0;
  const byWallet = new Map();

  if (RESUME && fs.existsSync(CKPT)) {
    const c = JSON.parse(fs.readFileSync(CKPT, 'utf8'));
    cursor = c.cursor;
    for (const [w, list] of Object.entries(c.byWallet)) byWallet.set(w, list);
    pages = c.pages || 0;
    console.log(`resuming from page ${pages}, ${byWallet.size} wallets so far`);
  }

  const t0 = Date.now();
  while (pages < MAXPAGES) {
    let url = `https://datapi.jup.ag/v1/txs/${CA}?limit=30`;
    if (cursor) url += `&offset=${cursor}`;

    const j = await getJson(url);
    const txs = j.txs || [];
    if (!txs.length) { console.log('feed exhausted'); cursor = null; break; }

    pages++;
    let hitCutoff = false;
    for (const t of txs) {
      if (Date.parse(t.timestamp) < cutoff) { hitCutoff = true; continue; }
      const w = t.traderAddress;
      if (!w) continue;
      if (!byWallet.has(w)) byWallet.set(w, []);
      byWallet.get(w).push({
        type: t.type, amount: t.amount, usdVolume: t.usdVolume,
        usdPrice: t.usdPrice, timestamp: t.timestamp, txHash: t.txHash,
        isValidPrice: t.isValidPrice,
      });
      kept++;
    }

    if (pages % 20 === 0) {
      const rate = pages / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  page ${pages} · ${byWallet.size} wallets · ${kept} trades · ${rate.toFixed(1)} pg/s · at ${txs[txs.length - 1].timestamp}   `);
      fs.writeFileSync(CKPT, JSON.stringify({ cursor: j.next, pages, byWallet: Object.fromEntries(byWallet) }));
    }

    if (hitCutoff) { console.log(`\nreached ${DAYS}d cutoff`); cursor = null; break; }
    cursor = j.next;
    if (!cursor) { console.log('\nno further cursor'); break; }
  }

  return { byWallet, pages, kept, truncated: !!cursor };
}

// ---- deep pass: full history per discovered wallet -----------------------------
// The window walk only sees trades INSIDE the window, so a wallet that bought earlier looks
// like an unscoreable seller. The filtered endpoint fixes that for cheap — it pages a single
// wallet's entire history, and real traders are 1-5 pages (117 trades came back in 4).
// Measured: a wallet reading $257/3tx from a 3.6h window reads $8,906/117tx deep. The window
// is only a DISCOVERY mechanism; this is where the numbers come from.
async function deepen(wallets) {
  const out = new Map();
  let done = 0, capped = 0;
  const CONC = 4;
  for (let i = 0; i < wallets.length; i += CONC) {
    await Promise.all(wallets.slice(i, i + CONC).map(async w => {
      let cursor = null, trades = [], pg = 0;
      try {
        while (pg < DEEP_MAXPG) {
          let u = `https://datapi.jup.ag/v1/txs/${CA}?limit=30&traderAddress=${w}`;
          if (cursor) u += `&offset=${cursor}`;
          const j = await getJson(u, 3);
          const txs = j.txs || [];
          if (!txs.length) break;
          trades.push(...txs); pg++;
          cursor = j.next;
          if (!cursor) break;
        }
        if (cursor) capped++;                 // hit the page ceiling; history is incomplete
        out.set(w, { trades, capped: !!cursor });
      } catch (e) { /* leave it out; the window numbers stand */ }
    }));
    done += Math.min(CONC, wallets.length - i);
    process.stdout.write(`\r  deep ${done}/${wallets.length} (${capped} hit page cap)   `);
  }
  console.log('');
  return out;
}

// ---- pump.fun identity (Node only — 403s from any browser origin) ---------------
async function resolveNames(wallets) {
  const out = {};
  const CONC = 6;
  let done = 0;
  for (let i = 0; i < wallets.length; i += CONC) {
    await Promise.all(wallets.slice(i, i + CONC).map(async w => {
      try {
        const u = await getJson(`https://frontend-api-v3.pump.fun/users/${w}`, 2);
        if (u && u.username) {
          out[w] = { name: u.username, img: u.profile_image || null,
                     followers: u.followers || 0, pump: !!u.is_pump_user };
        }
      } catch (e) { /* unresolved is fine — the address is the fallback label */ }
    }));
    done += Math.min(CONC, wallets.length - i);
    process.stdout.write(`\r  names ${done}/${wallets.length}   `);
  }
  console.log('');
  return out;
}

(async () => {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

  const tok = await getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${CA}`);
  const price = ((Array.isArray(tok) ? tok : []).find(t => t.id === CA) || {}).usdPrice || 0;
  console.log(`$ALON price $${price}\nwalking ${DAYS}d of trades (limit 30/page, serial cursor)...`);

  const { byWallet, pages, kept, truncated } = await walk();

  let sourceMap = byWallet, deepCapped = 0;
  const cappedSet = new Set();
  if (DEEP) {
    console.log(`deep pass: full history for ${byWallet.size} discovered wallets...`);
    const deep = await deepen([...byWallet.keys()]);
    sourceMap = new Map();
    for (const [w, list] of byWallet) {
      const d = deep.get(w);
      if (d) { sourceMap.set(w, d.trades); if (d.capped) { deepCapped++; cappedSet.add(w); } }
      else sourceMap.set(w, list);
    }
  }

  let rows = [];
  for (const [wallet, trades] of sourceMap) {
    const p = computePnl(trades, price);
    if (p.bought < MIN_USD && p.sold < MIN_USD) continue;
    rows.push({
      wallet, trades: p.trades, buys: p.buys, sells: p.sells,
      bought: +p.bought.toFixed(2), sold: +p.sold.toFixed(2),
      realized: +p.realized.toFixed(2), unrealized: +p.unrealized.toFixed(2),
      total: +p.total.toFixed(2), holding: +p.holding.toFixed(2),
      position: +p.position.toFixed(4), avgEntry: p.avgEntry,
      firstTs: p.firstTs, lastTs: p.lastTs,
      partial: p.flags.partial,
      // hit DEEP_MAXPG: we have the NEWEST N trades, so the oldest buys are missing and the
      // cost basis is understated — which inflates pnl. The signature is a high trade count
      // with $0 realized. Never present a capped row as a clean number.
      capped: cappedSet.has(wallet),
    });
  }
  const partials = rows.filter(r => r.partial);
  if (!KEEP_PARTIAL) rows = rows.filter(r => !r.partial);
  rows.sort((a, b) => b.total - a.total);

  let names = {};
  if (NAMES && rows.length) {
    console.log(`resolving pump.fun names for top ${Math.min(rows.length, 150)}...`);
    names = await resolveNames(rows.slice(0, 150).map(r => r.wallet));
    for (const r of rows) if (names[r.wallet]) Object.assign(r, names[r.wallet]);
  }

  const out = {
    generated: new Date().toISOString(),
    mint: CA, price,
    // coverage is stated, not implied — `truncated` means the walk stopped on the page
    // ceiling rather than the date cutoff, so the window is shallower than --days claims
    window: { days: DAYS, pagesWalked: pages, tradesKept: kept, truncated, minUsd: MIN_USD,
              rankable: rows.length, unscoreable: partials.length,
              // deep=true means the window only DISCOVERED wallets and every number below
              // comes from that wallet's full history, not the window slice
              deep: DEEP, deepCapped },
    traders: rows,
    // kept out of the ranking, kept in the file: their trade list still drives a replay
    unscoreable: KEEP_PARTIAL ? [] : partials.map(r => ({ wallet: r.wallet, trades: r.trades, sold: r.sold })),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  if (fs.existsSync(CKPT)) fs.unlinkSync(CKPT);

  console.log(`\nwrote ${path.relative(process.cwd(), OUT)} — ${rows.length} rankable traders from ${byWallet.size} wallets, ${pages} pages${truncated ? ' (TRUNCATED)' : ''}`);
  if (partials.length) console.log(`${partials.length} wallets unscoreable (bought before the window)${DEEP ? '' : ' — run --deep to recover them'}`);
  const capRows = rows.filter(r => r.capped).length;
  if (capRows) console.log(`⚠ ${capRows} ranked wallets hit the ${DEEP_MAXPG}-page deep cap — basis understated, pnl inflated. Raise --deep-max-pages or mark them in the UI.`);
  console.log('\ntop 10 by total pnl:');
  for (const r of rows.slice(0, 10)) {
    const tag = (r.partial ? ' ⚠partial' : '') + (r.capped ? ' ⚠capped' : '');
    console.log(`  ${(r.name || r.wallet.slice(0, 4) + '…' + r.wallet.slice(-4)).padEnd(20)} $${r.total.toFixed(0).padStart(9)}  (real $${r.realized.toFixed(0)} / unreal $${r.unrealized.toFixed(0)})  ${r.trades}tx${tag}`);
  }
})();
