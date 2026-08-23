// $PUMP comparison overlay: it draws, it's rebased to the visible left edge, it survives a
// timeframe switch, and it goes away again. Counts overlay pixels in the chart pane rather
// than trusting a flag — a series that exists but renders nothing would pass a flag check.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');
const URL = process.env.URL || 'http://localhost:8131/index.html';
const CANARY = process.env.CANARY === '1';
const fails = [], ok = [];
const check = (n, c) => { (c ? ok : fails).push(n); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the overlay is pure white (#ffffff) and nothing else on this chart is — the candles are
// #4ade80/#f87171, the axis text is grey #7d8b83, the price badge is dark-on-green. So near-pure
// white pixels inside the #chart canvases are the overlay and only the overlay.
const WHITE = `() => {
  // lightweight-charts renders the pane, the price scale and the time scale as SEPARATE
  // canvases. Scan only the pane — the price scale carries the last-value badge, whose white
  // text was showing up as ~100 baseline pixels and swamping the off-state check.
  const cs = [...document.querySelectorAll('#chart canvas')];
  if (!cs.length) return -1;
  const pane = cs.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  let d;
  try { d = pane.getContext('2d').getImageData(0, 0, pane.width, pane.height).data; } catch (e) { return -1; }
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 235 && d[i+1] > 235 && d[i+2] > 235 && d[i+3] > 140) n++;
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
  const white = () => page.evaluate(`(${WHITE})()`);

  check('toggle present', await page.$('#cmpBtn') !== null);
  check('off by default', !(await page.$eval('#cmpBtn', el => [...el.classList])).includes('on'));
  const before = await white();
  console.log('overlay px before: ' + before);
  check('nothing white on the chart while off', before < 40);

  if (!CANARY) await page.click('#cmpBtn');      // CANARY never turns it on -> the draw checks go red
  await sleep(7000);

  check('button lights up', (await page.$eval('#cmpBtn', el => [...el.classList])).includes('on') === !CANARY);
  const after = await white();
  console.log('overlay px after: ' + after);
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
  await sleep(7000);   // the 4H view re-pages $PUMP history, one throttled fetch at a time
  const after4h = await white();
  console.log('overlay px on 4H: ' + after4h);
  check('survives a timeframe switch', CANARY ? after4h < 40 : after4h > 300);

  // and it must come back off
  if (!CANARY) {
    await page.click('#cmpBtn');
    await sleep(1200);
    const off = await white();
    console.log('overlay px after off: ' + off);
    check('toggling off clears it', off < 40);
    check('choice persists', await page.evaluate(() => localStorage.getItem('cmpPump')) === 'no');
  }

  // the exported image has to say the overlay is on, or the second line is unexplained
  // (the legend swatch is the ONLY pure-white thing drawn; site text is #e9f2ec, r=233)
  const legend = async () => page.evaluate(() => new Promise(res => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.width; c.height = im.height;
      const g = c.getContext('2d');
      g.drawImage(im, 0, 0);
      const S = im.width / document.getElementById('chart').clientWidth;
      const d = g.getImageData(0, 0, c.width, Math.round(102 * S)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 250 && d[i+1] > 250 && d[i+2] > 250) n++;
      res(n);
    };
    im.src = window.__ctl.paintShot();
  }));
  if (!CANARY) {
    await page.click('#cmpBtn');            // back on for the card check
    await sleep(4000);
    const withOverlay = await legend();
    await page.click('#cmpBtn');
    await sleep(1500);
    const without = await legend();
    console.log(`card header white px: on=${withOverlay} off=${without}`);
    check('copied card shows a $PUMP legend when the overlay is on', withOverlay > 10);
    check('and no legend when it is off', without === 0);
  }

  check('no page errors', errors.length === 0);
  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  if (fails.length) console.log('FAILED: ' + fails.join(', '));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
