// smoke for the consolidated chart controls: one ALON toggle, one PUMP button.
// real-timed (rAF-driven sprite loop), system Chrome via playwright-core.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');

const URL = process.env.URL || 'http://localhost:8131/index.html';
const CANARY = process.env.CANARY === '1';
const fails = [];
const ok = [];
function check(name, cond) { (cond ? ok : fails).push(name); console.log((cond ? 'PASS ' : 'FAIL ') + name); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // --- the two deleted buttons are actually gone ---
  check('RUN toggle removed',      await page.$('#runToggle')   === null);
  check('MANIFEST button removed', await page.$('#manifestBtn') === null);
  check('ALON toggle present',     await page.$('#alonToggle')  !== null);
  check('PUMP button present',     await page.$('#boostBtn')    !== null);

  // --- default state: off, and breathing to advertise itself ---
  // exact class matching — "alon-toggle".includes('on') is true, substring tests pass vacuously here
  const cls = () => page.$eval('#alonToggle', el => [...el.classList]);
  const pumpCls = () => page.$eval('#boostBtn', el => [...el.classList]);
  check('alon OFF by default',  !(await cls()).includes('on'));
  check('alon breathes when unseen', (await cls()).includes('breathe'));
  check('pump breathes when unseen', (await pumpCls()).includes('breathe'));
  check('alon hidden while off',
        await page.$eval('#alonCursor', el => getComputedStyle(el).display) === 'none');

  // --- switch him on ---
  await page.click('#alonToggle');
  await sleep(600);
  check('alon ON after click', (await cls()).includes('on'));
  check('breathing stops after first click', !(await cls()).includes('breathe'));
  check('alon visible when on',
        await page.$eval('#alonCursor', el => getComputedStyle(el).display) !== 'none');
  check('not running yet', !(await cls()).includes('running'));

  // --- run has no button: an arrow key is the switch ---
  await page.keyboard.down('ArrowRight');
  await sleep(400);
  check('arrow key engages run', (await cls()).includes('running'));
  await page.keyboard.up('ArrowRight');
  await sleep(200);

  // --- turning alon off tears run down with it ---
  await page.click('#alonToggle');
  await sleep(400);
  check('alon OFF again', !(await cls()).includes('on'));
  check('run torn down with him', !(await cls()).includes('running'));
  check('alon hidden again',
        await page.$eval('#alonCursor', el => getComputedStyle(el).display) === 'none');

  // --- one press of PUMP does manifest + volume + puts him on the chart ---
  const st = () => page.evaluate(() => ({
    boosting: !!window.__ctl?.boosting(),
    manifesting: !!window.__ctl?.manifesting(),
    alonOn: document.getElementById('alonToggle').classList.contains('on'),
    lit: document.getElementById('boostBtn').classList.contains('on'),
  }));
  const before = await st();
  check('bridge reachable', typeof before.boosting === 'boolean');
  check('manifest off before pump', before.manifesting === false);

  const mcap0 = await page.$eval('#headMc', el => el.textContent.trim());
  await page.click('#boostBtn');
  await sleep(4200);                       // POP_MS animation has to clear first
  const after = await st();
  check('pump sets boosting',     after.boosting === true);
  check('pump turns alon on',     after.alonOn === true);
  check('pump button lit',        after.lit === true);
  // the whole point: it RAMPS, it doesn't teleport. manifest stays out of it.
  check('pump does NOT manifest', after.manifesting === (CANARY ? true : false));
  const mcap1 = await page.$eval('#headMc', el => el.textContent.trim());
  check('no instant jump to $1B', !/\$1\.\d+B/.test(mcap1));
  check('but the chart is moving', mcap1 !== mcap0);

  // --- and one more press puts it back ---
  await page.click('#boostBtn');
  await sleep(900);
  const off = await st();
  check('pump off clears boost', off.boosting === false);

  check('no page errors', errors.length === 0);

  await browser.close();
  console.log(`\n${ok.length} passed, ${fails.length} failed`);
  if (fails.length) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
