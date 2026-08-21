#!/usr/bin/env node
// $ALON holder conviction scanner.
//
// Two data sources, deliberately: signatures tell you WHEN a wallet last acted, our own
// daily balance snapshots tell you WHICH WAY it moved. Neither alone can separate
// "sold" from "bought more" — that's the distinction every other tracker collapses.
//
//   node tools/holder-scan.js --seed    full signature scan (~1 credit/holder, ~30min)
//   node tools/holder-scan.js           daily snapshot + diff (~180 credits, seconds)
//
// HELIUS_KEY in env. Falls back to the public RPC (slower, no key) when unset.

const fs = require('fs'), path = require('path');
const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
const DIR = path.join(__dirname, '..', 'holders');
const KEY = process.env.HELIUS_KEY || '';
const RPC = KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : 'https://api.mainnet-beta.solana.com';
const CONC = KEY ? 12 : 2;        // concurrent in-flight requests                    // free-tier rate limits; public RPC needs kid gloves
const SEED = process.argv.includes('--seed');
const LIMIT = (process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1];

let agg_excluded = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

let calls = 0;
async function rpc(method, params, tries = 4) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      calls++;
      if (j.error) {
        if (j.error.code === 429 || r.status === 429) { await sleep(a * 2000); continue; }
        throw new Error(method + ': ' + j.error.message);
      }
      return j.result;
    } catch (e) {
      if (a === tries) throw e;
      await sleep(a * 1200);
    }
  }
  throw new Error(method + ': rate limited after ' + tries + ' attempts');
}

// every holder + balance. DAS pages 1000 at a time; the public RPC has no DAS, so it falls
// back to the top-20 largest accounts (enough to prove the logic, not enough to ship on).
async function holders() {
  if (!KEY) {
    // no key: jupiter hands over the top 100 free (public RPC refuses getTokenLargestAccounts).
    // enough to validate the pipeline; Helius is what gets all 17.8k.
    const r = await fetch(`https://datapi.jup.ag/v1/holders/${CA}`);
    const j = await r.json();
    return (j.holders || []).map(h => ({
      account: h.address, owner: h.address, amount: +h.amount || 0,
      tags: (h.tags || []).map(t => t.id), holderTags: h.holderTags || [],
    }));
  }
  const dec = (await rpc('getTokenSupply', [CA])).value.decimals;
  const scale = Math.pow(10, dec);
  const out = [];
  for (let page = 1; ; page++) {
    const r = await rpc('getTokenAccounts', { mint: CA, page, limit: 1000 });
    const list = (r && r.token_accounts) || [];
    if (!list.length) break;
    for (const t of list) out.push({ account: t.address, owner: t.owner, amount: (+t.amount || 0) / scale });
    process.stderr.write(`\r  holders: ${out.length}`);
    if (list.length < 1000) break;
    await sleep(1000 / 2);                   // DAS is 2 req/s on free
  }
  process.stderr.write('\n');
  // DAS has no labels, so borrow Jupiter's — the LP/AMM accounts are always among the
  // largest, and leaving an 84M-token pool in the denominator distorts every percentage
  try {
    const j = await (await fetch(`https://datapi.jup.ag/v1/holders/${CA}`)).json();
    const tagged = new Map();
    for (const h of (j.holders || [])) {
      const t = (h.tags || []).map(x => x.id);
      if (t.length || (h.holderTags || []).length) tagged.set(h.address, { tags: t, holderTags: h.holderTags || [] });
    }
    let n = 0;
    for (const h of out) {
      const m = tagged.get(h.account) || tagged.get(h.owner);
      if (m) { h.tags = m.tags; h.holderTags = m.holderTags; n++; }
    }
    console.error(`  labelled ${n} accounts from jupiter`);
  } catch (e) { console.error('  (jupiter labels unavailable)'); }
  return out;
}

// one call per account: most recent signature -> last activity timestamp.
// a worker pool, not a loop: each request is ~200ms of latency, so going one at a time
// caps you around 5/s no matter what the rate limit allows. checkpoints as it goes so a
// killed scan resumes instead of starting over.
async function lastActivity(accounts, prior) {
  const seen = Object.assign({}, prior || {});
  const todo = accounts.filter(a => !(a.account in seen));
  console.error(`  ${accounts.length - todo.length} already known, ${todo.length} to fetch`);
  let i = 0, done = 0, t0 = Date.now();
  const ckpt = path.join(DIR, 'activity.json');

  async function worker() {
    while (i < todo.length) {
      const acct = todo[i++].account;
      try {
        const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 1 }]);
        seen[acct] = (sigs && sigs[0] && sigs[0].blockTime) || null;
      } catch (e) { seen[acct] = null; }
      if (++done % 250 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        process.stderr.write(`\r  signatures: ${done}/${todo.length}  ${rate.toFixed(1)}/s  eta ${Math.round((todo.length - done) / rate / 60)}m   `);
        fs.writeFileSync(ckpt, JSON.stringify(seen));
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // every token account has at least its own creation transaction, so a null here is a failed
  // fetch, not a dormant wallet. left alone it sits in the denominator unable to reach any
  // bucket, quietly deflating every percentage — so sweep them again before trusting the run.
  const missed = Object.keys(seen).filter(a => !seen[a]);
  if (missed.length) {
    console.error(`\n  retrying ${missed.length} unresolved`);
    let m = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, 8) }, async () => {
      while (m < missed.length) {
        const acct = missed[m++];
        const sigs = await rpc('getSignaturesForAddress', [acct, { limit: 1 }]);
        if (sigs && sigs[0] && sigs[0].blockTime) seen[acct] = sigs[0].blockTime;
      }
    }));
    console.error(`  still unresolved: ${Object.keys(seen).filter(a => !seen[a]).length}`);
  }
  fs.writeFileSync(ckpt, JSON.stringify(seen));
  process.stderr.write(`\n  done in ${Math.round((Date.now() - t0) / 60000)}m\n`);
  return seen;
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  console.error(`source: ${KEY ? 'helius' : 'public rpc (no key)'} · mode: ${SEED ? 'seed' : 'daily'}`);

  let list = await holders();
  if (LIMIT) list = list.slice(0, +LIMIT);
  const day = today();
  const snap = {};
  for (const h of list) snap[h.account] = h.amount;
  // keep owner + tags alongside: jupiter labels by OWNER, snapshots key by TOKEN ACCOUNT,
  // and losing the mapping means pool exclusion silently stops working downstream
  fs.writeFileSync(path.join(DIR, `owners-${day}.json`), JSON.stringify(
    Object.fromEntries(list.map(h => [h.account, [h.owner || '', (h.tags || []).join(',')]]))));
  fs.writeFileSync(path.join(DIR, `snap-${day}.json`), JSON.stringify(snap));

  for (const f of fs.readdirSync(DIR).filter(f => f.startsWith('snap-')).sort().slice(0, -7)) {
    fs.unlinkSync(path.join(DIR, f));            // 7 days of audit trail is plenty
  }
  const statePath = path.join(DIR, 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { wallets: {} };
  let now = Math.floor(Date.now() / 1000);
  try {
    const slot = await rpc('getSlot', []);
    const ct = await rpc('getBlockTime', [slot]);
    if (ct) now = ct;
  } catch (e) { console.error('  (chain time unavailable, using local clock)'); }

  if (SEED) {
    const ckpt = path.join(DIR, 'activity.json');
    const prior = fs.existsSync(ckpt) ? JSON.parse(fs.readFileSync(ckpt, 'utf8')) : {};
    const act = await lastActivity(list, prior);
    for (const h of list) {
      const w = state.wallets[h.account] || (state.wallets[h.account] = {});
      w.lastActive = act[h.account] || w.lastActive || null;
      w.amount = h.amount; w.dir = w.dir || 'flat';
    }
  } else {
    // the free half: a balance that didn't move means the wallet didn't act
    for (const h of list) {
      const w = state.wallets[h.account] || (state.wallets[h.account] = { lastActive: null, amount: h.amount, dir: 'flat' });
      const before = w.amount;
      if (before == null || h.amount === before) { w.dir = w.dir || 'flat'; }
      else { w.lastActive = now; w.dir = h.amount > before ? 'accumulating' : 'distributing'; }
      w.amount = h.amount;
    }
  }
  state.updated = now;
  fs.writeFileSync(statePath, JSON.stringify(state));

  // buckets. a wallet that only ever ADDED is still conviction — that's the call the
  // other trackers get wrong, and the reason we track direction at all.
  const DAY = 86400;
  const EXCLUDE = ['Pool', 'Amm', 'Vault'];
  const held = list.filter(h => h.amount > 0 &&
    !(h.tags || []).some(t => EXCLUDE.includes(t)));
  agg_excluded = list.length - held.length;
  const agg = { asOf: now, mint: CA, excluded: agg_excluded, holders: held.length, supplyTracked: 0,
                d7: 0, d14: 0, d30: 0, n7: 0, n14: 0, n30: 0, dated: 0, accumulating: 0, distributing: 0, flat: 0, unknown: 0 };
  for (const h of held) {
    const w = state.wallets[h.account] || {};
    agg.supplyTracked += h.amount;
    if (!w.lastActive) { agg.unknown++; continue; }
    agg.dated++;
    const age = now - w.lastActive;
    // supply-weighted AND wallet-weighted, because they answer different questions and one
    // whale can swing the first by 8% overnight while telling you nothing about behaviour
    if (age >= 7 * DAY)  { agg.d7 += h.amount;  agg.n7++; }
    if (age >= 14 * DAY) { agg.d14 += h.amount; agg.n14++; }
    if (age >= 30 * DAY) { agg.d30 += h.amount; agg.n30++; }
    if (w.dir === 'accumulating') agg.accumulating++;
    else if (w.dir === 'distributing') agg.distributing++;
    else agg.flat++;
  }
  for (const k of ['d7', 'd14', 'd30']) agg[k + 'Pct'] = agg.supplyTracked ? +(agg[k] / agg.supplyTracked * 100).toFixed(2) : 0;
  for (const k of ['7', '14', '30']) agg['w' + k + 'Pct'] = agg.dated ? +(agg['n' + k] / agg.dated * 100).toFixed(2) : 0;

  // "when did each holder last touch their bag" — a plain distribution off the current census.
  // no survivorship problem here: it describes who holds now, which is the question people
  // actually ask. buckets are in human units, not 7d/14d/30d jargon.
  const BUCKETS = [['moved today', 0, 1], ['this week', 1, 7], ['this month', 7, 30],
                   ['1-3 months', 30, 90], ['3-6 months', 90, 180],
                   ['6-12 months', 180, 365], ['over a year', 365, Infinity]];
  const ages = [];
  agg.dist = BUCKETS.map(([label]) => ({ label, wallets: 0, supply: 0 }));
  for (const h of held) {
    const w = state.wallets[h.account] || {};
    if (!w.lastActive) continue;
    const age = (now - w.lastActive) / DAY;
    ages.push(age);
    const i = BUCKETS.findIndex(([, lo, hi]) => age >= lo && age < hi);
    if (i >= 0) { agg.dist[i].wallets++; agg.dist[i].supply += h.amount; }
  }
  for (const b of agg.dist) {
    b.wPct = +(b.wallets / Math.max(ages.length, 1) * 100).toFixed(1);
    b.sPct = +(b.supply / Math.max(agg.supplyTracked, 1) * 100).toFixed(1);
    delete b.supply;
  }
  ages.sort((a, b) => a - b);
  agg.medianDays = ages.length ? Math.round(ages[Math.floor(ages.length / 2)]) : 0;
  fs.writeFileSync(path.join(__dirname, '..', 'conviction.json'), JSON.stringify(agg, null, 2));

  // one tiny row per day — this is the file that becomes the trend graph, and the only
  // artifact here that can't be rebuilt from the chain, so it's append-only
  const hp = path.join(DIR, 'history.json');
  const hist = fs.existsSync(hp) ? JSON.parse(fs.readFileSync(hp, 'utf8')) : [];
  const row = { d: day, holders: agg.holders, d7: agg.w7Pct, d14: agg.w14Pct, d30: agg.w30Pct,
                s7: agg.d7Pct, s14: agg.d14Pct, s30: agg.d30Pct,
                acc: agg.accumulating, dis: agg.distributing };
  const at = hist.findIndex(r => r.d === day);
  if (at >= 0) hist[at] = row; else hist.push(row);
  fs.writeFileSync(hp, JSON.stringify(hist));
  console.error(`\nrpc calls: ${calls}\n` + JSON.stringify(agg, null, 2));
})();
