// Does PUMP UR SHIT actually reach $1B in ~30s? Real-timed — no virtual clock (it starves rAF).
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');
const URL = process.env.URL || 'http://localhost:8131/index.html';
const RUNS = +(process.env.RUNS || 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// "$15.20M" -> 15200000
function parseMc(t) {
  const m = /\$([\d.]+)([KMBT]?)/.exec(t || '');
  if (!m) return NaN;
  return parseFloat(m[1]) * ({ '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 })[m[2]];
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const times = [];
  for (let run = 1; run <= RUNS; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => console.log('PAGEERROR ' + e));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const start0 = await page.$eval('#headMc', el => el.textContent.trim());

    await page.click('#boostBtn');
    let hit = null, peak = 0;
    const trail = [];
    // measured against the pump's OWN clock (boostT0), not wall time from the click — the pop
    // animation and my poll interval both sit between the two and would read as pump lag
    for (let i = 0; i < 260 && hit === null; i++) {
      await sleep(250);
      const s = await page.evaluate(() => ({ e: window.__ctl.elapsed(), m: window.__ctl.mcap() }));
      if (s.e == null || s.m == null) continue;
      peak = Math.max(peak, s.m);
      if (s.e % 5 < 0.3) trail.push(`${s.e.toFixed(0)}s $${(s.m/1e6).toFixed(0)}M`);
      if (s.m >= 1e9) hit = s.e;
    }
    console.log(`run ${run}: start ${start0} -> ${hit === null ? `NEVER (peak $${(peak/1e6).toFixed(0)}M)` : `$1B at ${hit.toFixed(1)}s`}`);
    console.log('        ' + trail.join('  '));
    times.push(hit);
    await page.close();
  }
  await browser.close();

  const good = times.filter(t => t !== null);
  console.log(`\nreached $1B: ${good.length}/${RUNS}`);
  if (good.length) {
    console.log(`min ${Math.min(...good).toFixed(1)}s  max ${Math.max(...good).toFixed(1)}s  ` +
                `avg ${(good.reduce((a, b) => a + b, 0) / good.length).toFixed(1)}s`);
  }
  const inBand = good.filter(t => t >= 20 && t <= 45).length;
  console.log(inBand === RUNS ? `PASS all ${RUNS} landed in the 20-45s band` :
                                `FAIL only ${inBand}/${RUNS} landed in the 20-45s band`);
  process.exit(inBand === RUNS ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
