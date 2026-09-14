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
const { holderVault, holderRewardsPda } = require('./pda.js');

const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const QUOTE_OFF = 83;
const KEY = process.env.HELIUS_KEY;
const RPC = KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : 'https://api.mainnet-beta.solana.com';
const CONC = KEY ? 8 : 2;
const RW_CAP = +(process.env.RW_CAP || (KEY ? 1500 : 100));   // payout-ledger txs walked per coin per run
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
    // layout from the pump IDL: quote_mint @83, creator_fee_bps u64 @115, can_edit @123,
    // is_holder_reward @124. bps 0 = the global default fee (vaults still fill). pump's own API reports is_holder_reward=false for EVERY custom
    // pair while the chain says 74 of 102 — trust the byte, not the API.
    feeBps: b.length > 123 ? u(115) : 0,
    isHolderReward: b.length > 124 && b[124] === 1,
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
    // HOLDER REWARDS. on a holder-reward coin the creator fee (feeBps, in ALON) is escrowed in
    // a per-coin vault — creator_vault(PDA["holder-rewards", mint]) — swept by pump into the
    // PDA's own token account, and paid to holders from there (distribute_fee_to_holders,
    // 8 wallets per tx, several times an hour). sweeps and payouts both reference the
    // holder-rewards PDA, so its signature list is the ledger: walked incrementally by cursor.
    // accrued = still escrowed (both accounts) + already paid out.
    let rw = null;
    if (cv.isHolderReward) {
      const vault = holderVault(mint), hrPda = holderRewardsPda(mint);
      let pending = old.rwPending || 0, paid = old.rwPaid || 0, cursor = old.rwCursor || null, partial = false;
      try {
        // two escrow accounts: the vault (fees land here on every trade) and the rewards
        // PDA's own token account (pump sweeps vault → pda with CollectCreatorFeeV2, then pays
        // holders out of it, 8 per DistributeFeeToHolders). pending is both; a payout is ALON
        // leaving the PAIR — a sweep between them nets to zero.
        const balOf = async owner => ((await rpc('getTokenAccountsByOwner', [owner, { mint: CA }, { encoding: 'jsonParsed' }])).value || [])
          .reduce((t, x) => t + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
        pending = await balOf(vault) + await balOf(hrPda);
        // ⚠ once a coin is BONDED, every pumpswap trade also references the holder-rewards
        // PDA (it's the pool's coin_creator_vault_authority), so an active bonded coin puts
        // ~1000 sigs/hour here and each needs a getTransaction to tell payout from trade.
        // page newest→oldest until the cursor, capped per run (public RPC would crawl for an
        // hour otherwise); the cursor only advances over what was processed and the coin is
        // flagged partial when the cap hit, so nothing is silently skipped — just deferred.
        let sigs = [], before;
        for (let pg = 0; pg < 20; pg++) {
          const page = await rpc('getSignaturesForAddress', [hrPda, { limit: 1000, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) }]);
          sigs.push(...page);
          if (page.length < 1000) break;               // reached the cursor (or the coin's birth)
          before = page[page.length - 1].signature;
        }
        // keep the OLDEST slice: everything newer stays above the new cursor, so the next run's
        // `until` returns exactly the unprocessed remainder. (first run on a 20k+ tx coin loses
        // history older than 20 pages — acceptable, those are the coin's earliest hours.)
        if (sigs.length > RW_CAP) { partial = true; sigs = sigs.slice(sigs.length - RW_CAP); }
        sigs.reverse();                                   // oldest first, so the cursor ends on the newest processed
        if (sigs.length > 20) console.log(`  ${mint.slice(0, 8)} ${(m.symbol || '').slice(0, 8)}: walking ${sigs.length} txs on the rewards pda${partial ? ' (capped, partial)' : ''}`);
        const bal = list => (list || []).filter(b => b.mint === CA && (b.owner === vault || b.owner === hrPda)).reduce((t, b) => t + (b.uiTokenAmount.uiAmount || 0), 0);
        for (const sg of sigs) {
          const tx = await rpc('getTransaction', [sg.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
          if (!tx || !tx.meta || tx.meta.err) continue;
          const out = bal(tx.meta.preTokenBalances) - bal(tx.meta.postTokenBalances);
          if (out > 0) paid += out;
        }
        if (sigs.length) cursor = sigs[sigs.length - 1].signature;
      } catch (e) { console.warn('  rewards ' + mint.slice(0, 8) + ': ' + e.message); }
      rw = { rwVault: vault, rwPending: pending, rwPaid: paid, rwAccrued: pending + paid, rwCursor: cursor, rwPartial: partial };
    }
    return {
      feeBps: cv.feeBps, hr: cv.isHolderReward, ...(rw || {}),
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
  const sum = k => list.reduce((t, c) => t + (c[k] || 0), 0);
  const rewards = { coins: list.filter(c => c.hr).length, accrued: sum('rwAccrued'), paid: sum('rwPaid'), pending: sum('rwPending') };
  const out = { updatedAt: Math.floor(Date.now() / 1000), quote: CA, count: list.length, heldAlon, rewards, coins: list };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const fresh = list.filter(c => !known.has(c.curve)).length;
  console.log(`wrote ${list.length} coins (${fresh} new, ${list.filter(c => c.complete).length} graduated, ${Math.round(heldAlon).toLocaleString()} ALON held; ${rewards.coins} holder-reward coins, ${Math.round(rewards.accrued).toLocaleString()} ALON accrued / ${Math.round(rewards.paid).toLocaleString()} paid) → ${path.relative(process.cwd(), OUT)}`);
})().catch(e => { console.error(e); process.exit(1); });
