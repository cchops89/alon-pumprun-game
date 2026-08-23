// smoke for the chart screenshot button: the card composes, has the right shape, and is not blank.
// real-timed, system Chrome via playwright-core. CANARY=1 proves the blank/height checks can fail.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');
const fs = require('fs');

const URL = process.env.URL || 'http://localhost:8131/index.html';
const CANARY = process.env.CANARY === '1';
const OUT = process.env.OUT || '/private/tmp/claude-501/-Users-christianmetaversal/991aa5e0-4c80-4568-855e-e5f62e16471c/scratchpad/shot.png';
const fails = [], ok = [];
function check(name, cond) { (cond ? ok : fails).push(name); console.log((cond ? 'PASS ' : 'FAIL ') + name); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  check('shot button present', await page.$('#shotBtn') !== null);
  check('toast element present', await page.$('#shotToast') !== null);
  check('button is labelled', /copy chart/i.test(await page.$eval('#shotBtn', el => el.textContent)));
  // exact class membership — "shotbtn" has no 'breathe' substring, but be strict anyway
  check('breathes before first use', (await page.$eval('#shotBtn', el => [...el.classList])).includes('breathe'));
  check('label is visible at desktop width', await page.$eval('#shotBtn', el => parseFloat(getComputedStyle(el).fontSize)) > 8);
  check('bar did not wrap', await page.$eval('.chart-bar', el => el.getBoundingClientRect().height) < 52);

  // draw a brush stroke and switch alon on, so the composite has every layer in it
  await page.click('#brushBtn');
  const box = await page.$eval('#chart', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.30, box.y + box.h * 0.60);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.w * (0.30 + i * 0.02), box.y + box.h * (0.60 - i * 0.02));
  await page.mouse.up();
  await page.click('#brushBtn');
  await page.click('#alonToggle');
  await sleep(1200);

  const info = await page.evaluate((canary) => {
    const url = window.__ctl.paintShot();
    return new Promise(res => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = im.width; c.height = im.height;
        const g = c.getContext('2d');
        if (!canary) g.drawImage(im, 0, 0);        // CANARY skips the draw -> blank card
        const chartCss = document.getElementById('chart').clientWidth;
        const S = im.width / chartCss;
        // distinct colours in the header band and in the chart band
        const uniq = band => {
          const d = g.getImageData(0, band[0], c.width, band[1] - band[0]).data;
          const set = new Set();
          for (let i = 0; i < d.length; i += 4 * 37) set.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
          return set.size;
        };
        res({ w: im.width, h: im.height, S, chartCss,
              headColours: uniq([0, Math.round(96 * S)]),
              chartColours: uniq([Math.round(96 * S), im.height - Math.round(34 * S)]),
              footColours: uniq([im.height - Math.round(34 * S), im.height]),
              url });
      };
      im.src = url;
    });
  }, CANARY);

  console.log(`card ${info.w}x${info.h} @${info.S}x  colours head/chart/foot = ${info.headColours}/${info.chartColours}/${info.footColours}`);
  fs.writeFileSync(OUT, Buffer.from(info.url.split(',')[1], 'base64'));
  console.log('wrote ' + OUT);

  // header layout chris asked for: chain stacked, "market cap" moved under the numbers
  check('chain is stacked, not one line',
        await page.$eval('.ct-chain', el => el.querySelectorAll('br').length === 1 && !/·/.test(el.textContent)));
  check('market cap label sits under the price column',
        await page.$eval('.ct-price .ct-cap', el => el.textContent.trim()) === 'market cap');
  check('pump toggle is compact',
        await page.$eval('#cmpBtn', el => el.getBoundingClientRect().height) < 36);

  check('card width matches chart width', Math.abs(info.w - info.chartCss * info.S) < 2);
  check('card is taller than the chart alone', info.h > Math.round(130 * info.S));
  check('header band is not blank', info.headColours > 4);
  check('chart band is not blank', info.chartColours > 8);
  check('footer band is not blank', info.footColours > 3);

  // the button itself: click it and the toast has to say something
  await page.click('#shotBtn');
  await sleep(900);
  check('breathe cleared after use', !(await page.$eval('#shotBtn', el => [...el.classList])).includes('breathe'));
  check('shotSeen persisted', await page.evaluate(() => localStorage.getItem('shotSeen')) === 'yes');
  const toast = await page.$eval('#shotToast', el => ({ t: el.textContent, on: el.classList.contains('show'), err: el.classList.contains('err') }));
  console.log('toast: ' + JSON.stringify(toast));
  check('toast fires on click', toast.on && toast.t.length > 0);
  check('toast is not an error', !toast.err);

  check('no page errors', errors.length === 0);

  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  if (fails.length) console.log('FAILED: ' + fails.join(', '));
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
