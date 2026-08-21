// Do the tab title, the header and the CHART agree, and stay agreeing?
// Real-timed and slow on purpose (~85s): the bug it guards against only appears with time.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');
const URL = process.env.URL || 'http://localhost:8131/index.html';
const CANARY = process.env.CANARY === '1';
const fails = [], ok = [];
const check = (n, c) => { (c ? ok : fails).push(n); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });

  const t0 = Date.now();
  const chartHits = [];
  page.on('request', r => { if (/v2\/charts/.test(r.url())) chartHits.push((Date.now() - t0) / 1000); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  const snap = async () => {
    const s = await page.evaluate(() => ({ chart: window.__ctl.chartMcap(), tok: window.__ctl.tokMcap() }));
    return { ...s, head: await page.$eval('#headMc', e => e.textContent),
             strip: await page.$eval('#sMcap', e => e.textContent),
             title: (await page.title()).split(' ')[0] };
  };
  const drift = s => Math.abs((s.chart - s.tok) / s.tok) * 100;

  const a = await snap();
  check('bridge exposes chart + token mcap', a.chart > 0 && a.tok > 0);
  check('title, header and strip agree at load', a.title === a.head && a.head === a.strip);

  // the actual bug: candles were fetched once at init and never again, so the chart froze
  // while the header kept ticking. Only a reload re-synced them.
  const before = chartHits.length;
  await sleep(75000);
  const after = chartHits.filter(t => t > 10).length;
  console.log(`  chart polls after init: ${after} (at ${chartHits.filter(t => t > 10).map(t => t.toFixed(0) + 's').join(', ') || 'none'})`);
  check('chart re-polls after load', CANARY ? after === 0 : after >= 2);

  const b = await snap();
  check('title, header and strip still agree', b.title === b.head && b.head === b.strip);
  check('chart tracks the token mcap', drift(b) < 0.5);
  console.log(`  drift chart-vs-token: ${drift(b).toFixed(3)}%  (chart ${b.chart|0} / tok ${b.tok|0})`);

  // and it survives being backgrounded — the old code updated the title alone while hidden,
  // leaving the tab reading newer than the header
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(35000);
  const h = await snap();
  check('title and header agree even while hidden', h.title === h.head);

  check('no page errors', errors.length === 0);
  await browser.close();
  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
