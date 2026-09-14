#!/usr/bin/env node
// Builds alon-pairs.json — every pump.fun coin launched with $ALON as its QUOTE asset
// (pump.fun "custom pairs", 2026-09). The page reads the file and overlays live prices.
//
//   node tools/build-alon-pairs.js            HELIUS_KEY in env optional; public RPC otherwise
//
// DISCOVERY IS ON-CHAIN, NOT THE PUMP API. frontend-api-v3.pump.fun/coins ignores every
// quote-mint filter spelling we tried and pages newest-first across ALL coins (hundreds a
// minute), so paging it is not a discovery strategy. getProgramAccounts on the pump program
// with a memcmp on BondingCurve.quote_mint IS: exhaustive, one call. Offset 83 =
// 8 discriminator + 5×u64 reserves/supply + complete(1) + creator(32) + is_mayhem(1) +
// is_cashback(1). Verified by decoding it back to the ALON mint. Curves come in two sizes
// (125 and 151 bytes) — the prefix is identical, only later fields differ.
//
// THE CURVE DOES NOT HOLD ITS MINT (the PDA is derived FROM the mint), so each new curve
// costs one getTokenAccountsByOwner. Known curve→mint pairs are cached in the output file,
// so steady-state runs only pay for new launches.
//
// pump.fun's API 403s any browser Origin — Node sends none — so name/image/created come
// from here, baked in. Jupiter search is the fallback when pump.fun is unreachable (GitHub
// runners sometimes catch a Cloudflare wall).

const fs = require('fs'), path = require('path');

const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const QUOTE_OFF = 83;
const KEY = process.env.HELIUS_KEY;
const RPC = KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : 'https://api.mainnet-beta.solana.com';
const CONC = KEY ? 8 : 2;
const OUT = path.join(__dirname, '..', 'alon-pairs.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(method, params, tries = 6) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(a * 5000); continue; }
      const j = await r.json();
      if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
      return j.result;
    } catch (e) { if (a === tries) throw e; await sleep(a * 1000); }
  }
  throw new Error(method + ': rate-limited ' + tries + 'x');   // never let a 429 read as "no accounts"
}

async function getJson(url, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { await sleep(a * 2000); continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return await r.json();
    } catch (e) { if (a === tries) { console.warn('  ' + e.message); return null; } await sleep(a * 800); }
  }
}

async function pmap(items, fn, conc) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

function decodeCurve(b64) {
  const b = Buffer.from(b64, 'base64');
  const u = o => Number(b.readBigUInt64LE(o));
  return {
    vTok: u(8), vQuote: u(16), rTok: u(24), rQuote: u(32), supply: u(40),
    complete: b[48] === 1,
  };
}

async function mintOf(curve) {
  for (const prog of [TOKEN_2022, TOKEN_LEGACY]) {
    const r = await rpc('getTokenAccountsByOwner', [curve, { programId: prog }, { encoding: 'jsonParsed' }]);
    const v = (r.value || []).map(x => x.account.data.parsed.info.mint).filter(m => m !== CA);
    if (v.length) return v[0];
  }
  // no token account (seen once on 96 — the curve's ATA can be gone): walk back to the
  // create tx, whose post-balances name the mint the curve was funded with.
  let before, oldest = null;
  for (let pg = 0; pg < 30; pg++) {
    const sigs = await rpc('getSignaturesForAddress', [curve, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!sigs.length) break;
    oldest = sigs[sigs.length - 1].signature; before = oldest;
    if (sigs.length < 1000) break;
  }
  if (!oldest) return null;
  const tx = await rpc('getTransaction', [oldest, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  const bal = ((tx && tx.meta && tx.meta.postTokenBalances) || []).find(b => b.owner === curve && b.mint !== CA);
  return bal ? bal.mint : null;
}

async function meta(mint) {
  const p = await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`);
  if (p && p.mint) {
    return {
      name: p.name || '', symbol: p.symbol || '', image: p.image_uri || '',
      creator: p.creator || '', createdAt: p.created_timestamp || 0,
      twitter: p.twitter || '', telegram: p.telegram || '', website: p.website || '',
      pool: p.pool_address || '', src: 'pump',
    };
  }
  const j = await getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
  const t = Array.isArray(j) ? j.find(x => x.id === mint) : null;
  if (t) {
    return {
      name: t.name || '', symbol: t.symbol || '', image: t.icon || '',
      creator: t.dev || '', createdAt: t.firstPool && t.firstPool.createdAt ? Date.parse(t.firstPool.createdAt) : 0,
      twitter: t.twitter || '', telegram: t.telegram || '', website: t.website || '', pool: '', src: 'jup',
    };
  }
  return null;
}

// discovery ALWAYS goes to the public RPC. helius refuses plain getProgramAccounts on the pump
// program (10M+ accounts) even with a memcmp that matches ~100, and its paged V2 walks the
// whole program in slices — one 10k-slice returned 0 matches and the cron committed an EMPTY
// list (2026-09-14). the public RPC answers the V1 call with the filter in ~1s.
async function scan() {
  const filters = [{ memcmp: { offset: QUOTE_OFF, bytes: CA } }];
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [PUMP, { encoding: 'base64', filters }] }),
        signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(a * 3000); continue; }
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { if (a === 4) throw new Error('public gPA: ' + e.message); await sleep(a * 2000); }
  }
  throw new Error('public gPA: rate-limited');
}

(async () => {
  let prev = { coins: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const known = new Map(prev.coins.map(c => [c.curve, c]));

  console.log(`scanning pump program for quote_mint=${CA} (public rpc; ${KEY ? 'helius' : 'public rpc'} for lookups)`);
  const accts = await scan();
  console.log(`${accts.length} curves on-chain, ${known.size} known`);
  // curves are never deleted, so the set can only grow. a scan that comes back smaller than
  // what we already know is a broken scan, not a smaller world — refuse to write it.
  if (accts.length < known.size) throw new Error(`scan returned ${accts.length} < ${known.size} known — not writing`);

  let done = 0;
  const coins = await pmap(accts, async a => {
    const curve = a.pubkey, cv = decodeCurve(a.account.data[0]);
    if (++done % 10 === 0) console.log(`  ${done}/${accts.length}`);
    const old = known.get(curve) || {};
    let mint = old.mint, m = old.name ? old : null;
    // a lookup that fails (public RPC 429s in bursts) must not sink the run: keep the coin's
    // last-known record, or skip it this tick — it's retried next run because it stays unknown.
    try {
      if (!mint) { mint = await mintOf(curve); if (!mint) { console.warn('  no mint for ' + curve); return null; } }
      if (!m || m.src === 'jup') { m = await meta(mint) || m; }
    } catch (e) { console.warn('  ' + curve.slice(0, 8) + ': ' + e.message); if (!mint) return null; }
    if (!m) { console.warn('  no metadata for ' + mint); m = { name: '', symbol: '', image: '', createdAt: 0, src: 'none' }; }
    // price in ALON per token = quote reserves / token reserves; both 6-decimal, so the
    // ratio needs no scaling. Once graduated the curve is frozen — the page reads the pool.
    const price = cv.vTok > 0 ? cv.vQuote / cv.vTok : 0;
    const supply = cv.supply / 1e6;
    // real ALON backing the coin right now: the curve's real quote reserve while it's live;
    // once bonded the curve is drained and the ALON lives in the pumpswap pool instead.
    // NOT "locked" — every sell pulls some of it back out. it's what holders haven't sold.
    let heldAlon = cv.complete ? 0 : cv.rQuote / 1e6;
    if (cv.complete && m.pool) {
      try {
        const r = await rpc('getTokenAccountsByOwner', [m.pool, { mint: CA }, { encoding: 'jsonParsed' }]);
        heldAlon = (r.value || []).reduce((t, x) => t + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
      } catch (e) { heldAlon = old.heldAlon || 0; console.warn('  pool balance ' + m.pool.slice(0, 8) + ': ' + e.message); }
    }
    return {
      heldAlon,
      mint, curve, name: m.name, symbol: m.symbol, image: m.image, creator: m.creator || '',
      createdAt: m.createdAt || 0, twitter: m.twitter || '', telegram: m.telegram || '', website: m.website || '',
      pool: m.pool || '', src: m.src,
      complete: cv.complete, supply, mcapAlon: price * supply,
      // progress toward graduation: real quote raised over the curve's cap (bonding curve holds
      // ~79% of supply at launch and graduates when real tokens run out)
      progress: cv.complete ? 1 : Math.max(0, Math.min(1, 1 - cv.rTok / (0.793e9 * 1e6))),
    };
  }, CONC);

  const list = coins.filter(Boolean).sort((a, b) => b.mcapAlon - a.mcapAlon);
  const heldAlon = list.reduce((t, c) => t + (c.heldAlon || 0), 0);
  const out = { updatedAt: Math.floor(Date.now() / 1000), quote: CA, count: list.length, heldAlon, coins: list };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const fresh = list.filter(c => !known.has(c.curve)).length;
  console.log(`wrote ${list.length} coins (${fresh} new, ${list.filter(c => c.complete).length} graduated, ${Math.round(heldAlon).toLocaleString()} ALON held) → ${path.relative(process.cwd(), OUT)}`);
})().catch(e => { console.error(e); process.exit(1); });
