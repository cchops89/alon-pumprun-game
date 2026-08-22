// $PUMP comparison overlay: it draws, it's rebased to the visible left edge, it survives a
// timeframe switch, and it goes away again. Counts violet pixels in the chart canvas rather
// than trusting a flag — a series that exists but renders nothing would pass a flag check.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');
const URL = process.env.URL || 'http://localhost:8131/index.html';
const CANARY = process.env.CANARY === '1';
const fails = [], ok = [];
const check = (n, c) => { (c ? ok : fails).push(n); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// #c084fc on a near-black chart — count pixels within tolerance of it
const VIOLET = `() => {
  const cs = [...document.querySelectorAll('#chart canvas')];
  let n = 0;
  for (const cv of cs) {
    let d;
    try { d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; } catch (e) { continue; }
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i] < 225 && d[i+1] > 95 && d[i+1] < 175 && d[i+2] > 210 && d[i+3] > 120) n++;
    }
  }
  return n;
}`;

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4500);

  // evaluate() needs an expression, and a bare arrow literal is a function OBJECT, not a call
  const violet = () => page.evaluate(`(${VIOLET})()`);

  check('toggle present', await page.$('#cmpBtn') !== null);
  check('off by default', !(await page.$eval('#cmpBtn', el => [...el.classList])).includes('on'));
  const before = await violet();
  console.log('violet px before: ' + before);
  check('nothing violet on the chart while off', before < 40);

  if (!CANARY) await page.click('#cmpBtn');      // CANARY never turns it on -> the draw checks go red
  await sleep(3500);

  check('button lights up', (await page.$eval('#cmpBtn', el => [...el.classList])).includes('on') === !CANARY);
  const after = await violet();
  console.log('violet px after: ' + after);
  check('overlay actually draws', after > before + 300);

  const st = await page.evaluate(() => window.__ctl.cmp());
  console.log('bridge: ' + JSON.stringify(st));
  check('overlay has candles behind it', CANARY ? st.rows === 0 : st.rows > 100);

  check('bridge agrees it is on', st.on === !CANARY);
  // rebased: the overlay's FIRST point must be the candle's own market cap at the anchor bar,
  // or the two lines don't leave the left edge together and the comparison is meaningless
  if (!CANARY) {
    const d = st.dbg || {};
    console.log('anchor: ' + JSON.stringify(d));
    check('overlay is rebased onto the anchor candle',
          d.cmp != null && d.alon > 0 && Math.abs(d.cmp - d.alon) / d.alon < 1e-9);
    check('anchor is inside the visible range', d.n > 20);
  }

  // a timeframe switch must not drop it
  await page.click('.tf[data-tf="4h"]');
  await sleep(3500);
  const after4h = await violet();
  console.log('violet px on 4H: ' + after4h);
  check('survives a timeframe switch', CANARY ? after4h < 40 : after4h > 300);

  // and it must come back off
  if (!CANARY) {
    await page.click('#cmpBtn');
    await sleep(1200);
    const off = await violet();
    console.log('violet px after off: ' + off);
    check('toggling off clears it', off < 40);
    check('choice persists', await page.evaluate(() => localStorage.getItem('cmpPump')) === 'no');
  }

  check('no page errors', errors.length === 0);
  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  if (fails.length) console.log('FAILED: ' + fails.join(', '));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
