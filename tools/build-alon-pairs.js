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

async function rpc(method, params, tries = 4) {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(a * 2000); continue; }
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

// helius refuses plain getProgramAccounts on the pump program ("too many accounts", 10M+) even
// with a memcmp that matches ~100 — it wants the paged V2. the public RPC still serves V1 fine
// (~1s), so it is the fallback if V2 ever misbehaves.
async function scan() {
  const filters = [{ memcmp: { offset: QUOTE_OFF, bytes: CA } }];
  if (KEY) {
    try {
      const out = []; let paginationKey;
      for (let pg = 0; pg < 50; pg++) {
        const r = await rpc('getProgramAccountsV2', [PUMP, { encoding: 'base64', limit: 10000, filters, ...(paginationKey ? { paginationKey } : {}) }]);
        out.push(...(r.accounts || []));
        paginationKey = r.paginationKey;
        if (!paginationKey || !(r.accounts || []).length) break;
      }
      return out;
    } catch (e) { console.warn('  helius V2 scan failed, falling back to public rpc: ' + e.message); }
  }
  const r = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [PUMP, { encoding: 'base64', filters }] }),
    signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (j.error) throw new Error('public gPA: ' + JSON.stringify(j.error));
  return j.result;
}

(async () => {
  let prev = { coins: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const known = new Map(prev.coins.map(c => [c.curve, c]));

  console.log(`scanning pump program for quote_mint=${CA} via ${KEY ? 'helius' : 'public rpc'}`);
  const accts = await scan();
  console.log(`${accts.length} curves on-chain, ${known.size} known`);

  let done = 0;
  const coins = await pmap(accts, async a => {
    const curve = a.pubkey, cv = decodeCurve(a.account.data[0]);
    if (++done % 10 === 0) console.log(`  ${done}/${accts.length}`);
    const old = known.get(curve) || {};
    let mint = old.mint, m = old.name ? old : null;
    if (!mint) { mint = await mintOf(curve); if (!mint) { console.warn('  no mint for ' + curve); return null; } }
    if (!m || m.src === 'jup') { m = await meta(mint) || m; }
    if (!m) { console.warn('  no metadata for ' + mint); m = { name: '', symbol: '', image: '', createdAt: 0, src: 'none' }; }
    // price in ALON per token = quote reserves / token reserves; both 6-decimal, so the
    // ratio needs no scaling. Once graduated the curve is frozen — the page reads the pool.
    const price = cv.vTok > 0 ? cv.vQuote / cv.vTok : 0;
    const supply = cv.supply / 1e6;
    return {
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
  const out = { updatedAt: Math.floor(Date.now() / 1000), quote: CA, count: list.length, coins: list };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const fresh = list.filter(c => !known.has(c.curve)).length;
  console.log(`wrote ${list.length} coins (${fresh} new, ${list.filter(c => c.complete).length} graduated) → ${path.relative(process.cwd(), OUT)}`);
})().catch(e => { console.error(e); process.exit(1); });
