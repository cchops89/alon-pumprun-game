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
const { holderVault, holderRewardsPda, bondingCurve, ata } = require('./pda.js');

const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const QUOTE_OFF = 83;
const KEY = process.env.HELIUS_KEY;
const RPC = KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : 'https://api.mainnet-beta.solana.com';
const CONC = KEY ? 8 : 2;
const RW_CAP = +(process.env.RW_CAP || (KEY ? 1500 : 100));   // payout-ledger txs walked per coin per run
const WALK_SLOTS = +(process.env.WALK_SLOTS || 108000);         // full helius walk at most every ~12h (≈9k slots/h) — it's ~1,500 credits
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

// DISCOVERY — built around what is cheap. helius bills 1 credit per call, and the only
// exhaustive query (getProgramAccountsV2 on the pump program) is ~1,200 calls because it
// slices the whole 10M-account program regardless of the memcmp — changedSinceSlot does NOT
// prune (2026-09-15: 1,201 pages to find 13 changes). so:
//   every run   : known curves ∪ mints dexscreener lists for the ALON quote (free, catches the
//                 active new launches) → ONE getMultipleAccounts per 100 curves refreshes every
//                 reserve. ~3 credits.
//   every ~12h  : the full V2 walk, to catch launches dexscreener never surfaced. ~1,500 credits.
//   no key      : the public RPC's V1 gPA (full) — which began 503ing every gPA on 2026-09-15.
//                 if it fails the run continues on known ∪ dexscreener.
// and it is always MERGE, never replace: an unbounded V2 walk once returned 0 and the cron
// committed an EMPTY list (2026-09-14).
async function walkV2() {
  const out = []; let paginationKey, pages = 0;
  for (; pages < 1500; pages++) {
    const r = await rpc('getProgramAccountsV2', [PUMP, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, limit: 10000,
      filters: [{ memcmp: { offset: QUOTE_OFF, bytes: CA } }], ...(paginationKey ? { paginationKey } : {}) }]);
    const acc = r.accounts || [];
    out.push(...acc.map(x => x.pubkey));
    paginationKey = r.paginationKey;
    // with a memcmp a slice is often legitimately empty, so "no accounts" is NOT the end —
    // only a null key is. observed: the key never nulled in 1,200 pages, so the cap is the
    // real bound and the walk costs ~1,500 credits. hence WALK_SLOTS keeps it to twice a day.
    if (!paginationKey) break;
  }
  console.log(`  helius V2 walk: ${out.length} curves in ${pages + 1} pages${paginationKey ? ' (cap hit, key still live)' : ' (key nulled)'}`);
  return out;
}
async function publicV1() {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [PUMP, { encoding: 'base64', dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: QUOTE_OFF, bytes: CA } }] }] }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status === 503) { await sleep(a * 4000); continue; }
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result.map(x => x.pubkey);
    } catch (e) { if (a === 3) { console.warn('  public gPA failed: ' + e.message); return null; } await sleep(a * 2000); }
  }
  console.warn('  public gPA: 503/429 on every try (the public RPC has been refusing getProgramAccounts since 2026-09-15)');
  return null;
}
async function dexscreenerMints() {
  const j = await getJson(`https://api.dexscreener.com/token-pairs/v1/solana/${CA}`);
  return (Array.isArray(j) ? j : []).filter(p => p.quoteToken && p.quoteToken.address === CA && /^pump/.test(p.dexId || '') && p.baseToken)
    .map(p => p.baseToken.address);
}
async function accountsOf(pubkeys) {
  const out = new Map();
  for (let i = 0; i < pubkeys.length; i += 100) {
    const r = await rpc('getMultipleAccounts', [pubkeys.slice(i, i + 100), { encoding: 'base64' }]);
    (r.value || []).forEach((v, k) => { if (v) out.set(pubkeys[i + k], v); });
  }
  return out;
}
async function tokenBalances(atas) {          // parsed ui amounts for a list of token accounts, 100 per credit
  const out = new Map();
  for (let i = 0; i < atas.length; i += 100) {
    const r = await rpc('getMultipleAccounts', [atas.slice(i, i + 100), { encoding: 'jsonParsed' }]);
    (r.value || []).forEach((v, k) => {
      const info = v && v.data && v.data.parsed && v.data.parsed.info;
      out.set(atas[i + k], info && info.tokenAmount ? (info.tokenAmount.uiAmount || 0) : 0);
    });
  }
  return out;
}

(async () => {
  let prev = { coins: [] };
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const known = new Map(prev.coins.map(c => [c.curve, c]));
  const mintByCurve = new Map(prev.coins.map(c => [c.curve, c.mint]));

  // ---- discovery ----
  const curves = new Set(known.keys());
  let slot = prev.scanSlot || null, walked = null;
  const ds = await dexscreenerMints();
  for (const m of ds) { const c = bondingCurve(m); mintByCurve.set(c, m); curves.add(c); }
  if (KEY) {
    const cur = await rpc('getSlot', []);
    if (!prev.scanSlot || cur - prev.scanSlot > WALK_SLOTS) {
      console.log(`full helius walk (last at slot ${prev.scanSlot || 'never'}, now ${cur})`);
      try { walked = await walkV2(); slot = cur; }
      catch (e) { console.warn('  full walk failed, continuing on known ∪ dexscreener: ' + e.message); }
    } else console.log(`no full walk this run (last ${cur - prev.scanSlot} slots ago, walk every ${WALK_SLOTS})`);
  } else {
    console.log('no HELIUS_KEY — trying the public RPC full scan');
    walked = await publicV1();
  }
  if (walked) {
    // curves are never deleted, so a full scan smaller than what we know is a broken scan
    if (walked.length < known.size) throw new Error(`full scan returned ${walked.length} < ${known.size} known — not writing`);
    walked.forEach(c => curves.add(c));
  }
  const all = [...curves];
  const acctMap = await accountsOf(all);
  console.log(`${all.length} curves (${known.size} known, ${ds.length} via dexscreener${walked ? ', ' + walked.length + ' via full scan' : ''}), ${acctMap.size} accounts read`);
  if (acctMap.size < known.size * 0.9) throw new Error(`only ${acctMap.size} of ${all.length} curve accounts came back — not writing`);

  // ---- rewards escrow balances in bulk: vault ATA + rewards-pda ATA for every known holder-reward coin ----
  const escrow = new Map();       // curve → { vault, hrPda, vAta, pAta }
  for (const c of all) {
    const mint = mintByCurve.get(c); if (!mint) continue;
    const acc = acctMap.get(c); if (!acc) continue;
    const cv = decodeCurve(acc.data[0]); if (!cv.isHolderReward) continue;
    const vault = holderVault(mint), hrPda = holderRewardsPda(mint);
    escrow.set(c, { vault, hrPda, vAta: ata(vault, CA), pAta: ata(hrPda, CA) });
  }
  const balances = await tokenBalances([...escrow.values()].flatMap(e => [e.vAta, e.pAta]));

  let done = 0;
  const coins = await pmap(all.filter(c => acctMap.has(c)), async curve => {
    const cv = decodeCurve(acctMap.get(curve).data[0]);
    if (++done % 25 === 0) console.log(`  ${done}/${all.length}`);
    const old = known.get(curve) || {};
    let mint = mintByCurve.get(curve), m = old.name ? old : null;
    // a lookup that fails must not sink the run: keep the coin's last-known record, or skip it
    // this tick — it's retried next run because it stays unknown.
    try {
      if (!mint) { mint = await mintOf(curve); if (!mint) { console.warn('  no mint for ' + curve); return null; } }
      if (!m || m.src === 'jup') { m = await meta(mint) || m; }
    } catch (e) { console.warn('  ' + curve.slice(0, 8) + ': ' + e.message); if (!mint) return null; }
    if (!m) { console.warn('  no metadata for ' + mint); m = { name: '', symbol: '', image: '', createdAt: 0, src: 'none' }; }
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
    // HOLDER REWARDS. the creator fee (feeBps, in ALON) is escrowed in a per-coin vault —
    // creator_vault(PDA["holder-rewards", mint]) — swept by pump into the PDA's own token
    // account, and paid to holders from there (distribute_fee_to_holders, 8 wallets per tx).
    // sweeps and payouts both reference the holder-rewards PDA, so its signature list is the
    // ledger, walked incrementally by cursor — but only when an escrow balance moved since
    // the last run: unchanged balances mean no trade, no sweep, no payout, so no credits spent.
    let rw = null;
    if (cv.isHolderReward && escrow.has(curve)) {
      const { vault, hrPda, vAta, pAta } = escrow.get(curve);
      const vBal = balances.get(vAta) || 0, pBal = balances.get(pAta) || 0, pending = vBal + pBal;
      let paid = old.rwPaid || 0, cursor = old.rwCursor || null, partial = !!old.rwPartial;
      const moved = old.rwVaultBal !== vBal || old.rwPdaBal !== pBal || !cursor || partial;
      if (moved) {
        try {
          // ⚠ once BONDED, every pumpswap trade also references the holder-rewards PDA (it's
          // the pool's coin_creator_vault_authority) — an active bonded coin is ~1000 sigs/hour
          // here, each needing a getTransaction to tell payout from trade. capped per run; the
          // cursor only advances over what was processed, partial flags the remainder.
          let sigs = [], before;
          for (let pg = 0; pg < 20; pg++) {
            const page = await rpc('getSignaturesForAddress', [hrPda, { limit: 1000, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) }]);
            sigs.push(...page);
            if (page.length < 1000) break;
            before = page[page.length - 1].signature;
          }
          partial = false;
          if (sigs.length > RW_CAP) { partial = true; sigs = sigs.slice(sigs.length - RW_CAP); }   // keep the OLDEST slice
          sigs.reverse();
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
      }
      rw = { rwVault: vault, rwPending: pending, rwPaid: paid, rwAccrued: pending + paid, rwCursor: cursor, rwPartial: partial, rwVaultBal: vBal, rwPdaBal: pBal };
    }
    return {
      feeBps: cv.feeBps, hr: cv.isHolderReward, ...(rw || {}),
      heldAlon,
      mint, curve, name: m.name, symbol: m.symbol, image: m.image, creator: m.creator || '',
      createdAt: m.createdAt || 0, twitter: m.twitter || '', telegram: m.telegram || '', website: m.website || '',
      pool: m.pool || '', src: m.src,
      complete: cv.complete, supply, mcapAlon: price * supply,
      // progress toward graduation: bonding curve holds ~79% of supply at launch and
      // graduates when real tokens run out
      progress: cv.complete ? 1 : Math.max(0, Math.min(1, 1 - cv.rTok / (0.793e9 * 1e6))),
    };
  }, CONC);

  const list = coins.filter(Boolean).sort((a, b) => b.mcapAlon - a.mcapAlon);
  if (list.length < known.size * 0.9) throw new Error(`only ${list.length} coins resolved of ${known.size} known — not writing`);
  const heldAlon = list.reduce((t, c) => t + (c.heldAlon || 0), 0);
  const sum = k => list.reduce((t, c) => t + (c[k] || 0), 0);
  const rewards = { coins: list.filter(c => c.hr).length, accrued: sum('rwAccrued'), paid: sum('rwPaid'), pending: sum('rwPending') };
  const out = { updatedAt: Math.floor(Date.now() / 1000), scanSlot: slot, quote: CA, count: list.length, heldAlon, rewards, coins: list };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const fresh = list.filter(c => !known.has(c.curve)).length;
  console.log(`wrote ${list.length} coins (${fresh} new, ${list.filter(c => c.complete).length} graduated, ${Math.round(heldAlon).toLocaleString()} ALON held; ${rewards.coins} holder-reward coins, ${Math.round(rewards.accrued).toLocaleString()} ALON accrued / ${Math.round(rewards.paid).toLocaleString()} paid) → ${path.relative(process.cwd(), OUT)}`);
})().catch(e => { console.error(e); process.exit(1); });
