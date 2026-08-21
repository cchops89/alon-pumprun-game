// conviction share card: all three cards open the same one, it renders, it copies, it closes.
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL_(URL).origin });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  const shown = () => page.$eval('#convLb', el => el.classList.contains('show'));
  const c = await page.evaluate(async () => await (await fetch('conviction.json?t=' + Date.now())).json());

  check('lightbox starts closed', !(await shown()));

  // every card opens the SAME card — that's the whole point of this revision
  for (let i = 0; i < 3; i++) {
    await (await page.$$('#convCards .conv-card'))[i].click();
    await sleep(700);
    check(`card ${i} opens the share card`, await shown());
    check(`card ${i} shows the canvas`, (await page.$('#shareCv')) !== null);
    await page.keyboard.press('Escape');
    await sleep(250);
  }

  await (await page.$$('#convCards .conv-card'))[0].click();
  await sleep(900);

  // the canvas actually has something on it, at the size we claim
  const cv = await page.evaluate(() => {
    const el = document.getElementById('shareCv'), x = el.getContext('2d');
    const d = x.getImageData(0, 0, el.width, el.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] * 0.3 + d[i + 1] * 0.6 + d[i + 2] * 0.1 > 70) ink++;
    return { w: el.width, h: el.height, ink };
  });
  check('card is 1200x1000', cv.w === 1200 && cv.h === 1000);
  check('card is wider than tall, near square', cv.w / cv.h > 1 && cv.w / cv.h < 1.4);
  check('card actually rendered', cv.ink > (CANARY ? 1e9 : 20000));

  // the three lines
  const txt = await page.$eval('#shareTxt', el => el.textContent);
  const lines = txt.split('\n');
  check('exactly three lines', lines.length === 3);
  check('all lowercase', txt === txt.toLowerCase());
  // the headline is the 6-month window; d180Pct once a scan has emitted it, else the two
  // buckets above 180 days — the same cut, since BUCKETS breaks at exactly 180
  const sixMo = c.d180Pct != null ? c.d180Pct
      : +c.dist.filter(b => b.label === '6-12 months' || b.label === 'over a year')
               .reduce((a, b) => a + b.sPct, 0).toFixed(1);
  check('line 1 says 6 months, not a week', /6 months/.test(lines[0]) && !/a week/.test(lines[0]));
  check('line 1 has the real 6-month figure', lines[0].includes(sixMo.toFixed(0) + '%'));
  check('6-month figure is below the 7-day one', sixMo < c.d7Pct);
  check('line 2 has the real holder count', lines[1].includes(c.holders.toLocaleString()));
  check('line 3 has the real 30d growth', lines[2].includes(c.growth.d30.toLocaleString()));

  // copy text really lands on the clipboard
  await page.click('#shareCopy');
  await sleep(500);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('copy text puts the three lines on the clipboard', clip === txt);

  // download really produces a png
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
                                  page.click('#shareDl')]);
  check('download fires', dl !== null);
  check('download is a png', dl ? /\.png$/.test(dl.suggestedFilename()) : false);

  // clicking inside must not close — the classic backdrop-handler bug
  await page.click('#shareTxt');
  await sleep(250);
  check('clicking inside keeps it open', await shown());

  await page.click('#convLbX'); await sleep(300);
  check('× closes it', !(await shown()));
  await (await page.$$('#convCards .conv-card'))[0].click(); await sleep(600);
  await page.mouse.click(20, 20); await sleep(300);
  check('backdrop click closes it', !(await shown()));
  check('body scroll restored', await page.$eval('body', el => el.style.overflow) === '');
  check('no page errors', errors.length === 0);

  await browser.close();
  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

function URL_(u) { return new (require('url').URL)(u); }
