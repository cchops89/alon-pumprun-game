// Solana PDA derivation with no dependencies: sha256 from node's crypto, base58, and the
// ed25519 on-curve test (a PDA is the first bump whose hash is NOT a valid curve point).
// Used by build-alon-pairs.js to locate each holder-reward coin's fee vault:
//   creator_vault( holder_rewards(mint) )  =  ["creator-vault", PDA(["holder-rewards", mint])]
// Validated against the pump Global PDA and an observed vault (G9jfCgLe… for 5hfCB5Nu…).
const { createHash } = require('crypto');

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58d(s) {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(ALPH.indexOf(ch));
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
}
function b58e(buf) {
  let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  let z = 0; while (z < buf.length && buf[z] === 0) z++;
  return '1'.repeat(z) + s;
}
const P = (1n << 255n) - 19n;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const mod = (a, m) => ((a % m) + m) % m;
const D = mod(-121665n * modpow(121666n, P - 2n, P), P);
const I = modpow(2n, (P - 1n) / 4n, P);
function onCurve(buf) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(buf[i]);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const u = mod(y * y - 1n, P), v = mod(D * y * y + 1n, P);
  const x2 = u * modpow(v, P - 2n, P) % P;
  let x = modpow(x2, (P + 3n) / 8n, P);
  if (mod(x * x - x2, P) !== 0n) x = x * I % P;
  return mod(x * x - x2, P) === 0n;
}
const PUMP = b58d('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
function pda(seeds, prog = PUMP) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256').update(Buffer.concat([...seeds, Buffer.from([bump]), prog, Buffer.from('ProgramDerivedAddress')])).digest();
    if (!onCurve(h)) return b58e(h);
  }
}
const ATA_PROGRAM = b58d('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_LEGACY = b58d('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// associated token account: PDA([owner, token_program, mint]) under the ATA program
const ata = (owner, mint, tokenProgram = TOKEN_LEGACY) => pda([b58d(owner), tokenProgram, b58d(mint)], ATA_PROGRAM);
const bondingCurve = mint => pda([Buffer.from('bonding-curve'), b58d(mint)]);
const creatorVault = creator => pda([Buffer.from('creator-vault'), b58d(creator)]);
const holderRewardsPda = mint => pda([Buffer.from('holder-rewards'), b58d(mint)]);
const holderVault = mint => creatorVault(holderRewardsPda(mint));

module.exports = { pda, b58d, b58e, ata, bondingCurve, creatorVault, holderRewardsPda, holderVault };

if (require.main === module) {
  const ok1 = pda([Buffer.from('global')]) === '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
  const ok2 = holderVault('5hfCB5NuXkuDWGp4tbjuaCgGseBviJYg7Kkzt9d7pump') === 'G9jfCgLeXNY45krKFQbLCdA3sdvtECSyRiudqS6sW82c';
  // SeAlon: curve 3Js43QaZ… per pump's api; its curve's ALON ATA is DL2v8byg… (associated_bonding_curve is the BASE ata, so check the curve pda only)
  const ok3 = bondingCurve('GdELihwJ1uQjkSxaSTsBdb71TNhVoUi4QtJG1Mptpump') === '3Js43QaZFDDQgE16QJ1vD8anC1GfHBM1MRud26fY2Ds6';
  console.log('global pda', ok1 ? 'ok' : 'WRONG', '| holder vault', ok2 ? 'ok' : 'WRONG', '| bonding curve', ok3 ? 'ok' : 'WRONG');
  process.exit(ok1 && ok2 && ok3 ? 0 : 1);
}
