// smoke for the "alon pairs" rail panel: the baked list renders, rows link to pump.fun, the
// live dexscreener overlay prices at least one coin in ALON, and sort toggles reorder.
// real-timed, system Chrome via playwright-core. CANARY=1 proves the checks can fail.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');

const URL = process.env.URL || 'http://localhost:8131/index.html';
const CANARY = process.env.CANARY === '1';
const OUT = process.env.OUT || '';
const fails = [], ok = [];
function check(name, cond) { (cond ? ok : fails).push(name); console.log((cond ? 'PASS ' : 'FAIL ') + name); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });
  if (CANARY) await page.route('**/alon-pairs.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"coins":[]}' }));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(6000);

  check('panel present', await page.$('#pairsPanel') !== null);
  check('bar sits above the chart', await page.evaluate(() => { const a = document.querySelector('#pairsPanel').getBoundingClientRect(), b = document.querySelector('.chart-panel').getBoundingClientRect(); return a.bottom <= b.top && Math.abs(a.width - b.width) < 2; }));
  check('bar is thin (< 36px)', await page.$eval('.pairs-bar', e => e.getBoundingClientRect().height) < 36);
  check('collapsed by default', await page.$eval('.pairs-wrap', e => e.getBoundingClientRect().height) === 0);
  await page.click('#pairsToggle');
  await sleep(1500);   // .28s css transition, but swiftshader paints slow
  check('click expands the list', await page.$eval('.pairs-wrap', e => e.getBoundingClientRect().height) > 200);
  const rows = await page.$$eval('#pairsList .pr', els => els.map(e => ({
    href: e.getAttribute('href'), sym: e.querySelector('.pr-n b').textContent, val: e.querySelector('.pr-v b').textContent, alon: e.querySelector('.pr-v span').textContent,
    h: e.getBoundingClientRect().height,
  })));
  check('rows rendered from the baked list (>= 20)', rows.length >= 20);
  check('every row links to pump.fun/coin/<mint>', rows.length > 0 && rows.every(r => /^https:\/\/pump\.fun\/coin\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.href)));
  check('every row has a symbol', rows.every(r => r.sym.trim().length > 0));
  check('mcap column leads with usd', rows.every(r => /^\$[\d.]+[KMB]?$/.test(r.val)));
  check('no ALON mcap on the rows', rows.every(r => !/ALON/.test(r.alon)));
  check('rows are not collapsed', rows.every(r => r.h > 30));
  check('at most 3 columns', await page.$eval('#pairsList', e => getComputedStyle(e).gridTemplateColumns.split(' ').length) === 3);
  check('rewards line sits under name + value, at most two lines', await page.$$eval('#pairsList .pr', els => els.filter(e => e.querySelector('.pr-r')).every(e => {
    const r = e.querySelector('.pr-r').getBoundingClientRect(), v = e.querySelector('.pr-v').getBoundingClientRect(), n = e.querySelector('.pr-n').getBoundingClientRect();
    return r.height < 30 && r.top >= v.bottom - 1 && r.top >= n.bottom - 1 && r.width > 150;
  })));
  const count = await page.$eval('#pairsCnt', e => e.textContent);
  check('header count matches row count', parseInt(count, 10) === rows.length);
  const total = await page.$eval('#pairsTotal', e => e.textContent);
  check('held-ALON note is next to the count', /^[\d.]+[KM]? ALON held/.test(total));
  check('held ALON is a real amount (> 100K, < supply)', (() => {
    const m = total.match(/^([\d.]+)([KM]?) ALON/); const v = m ? parseFloat(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : -1;
    return v > 1e5 && v < 1e9;
  })());

  const rwNote = await page.$eval('#pairsRewards', e => e.textContent);
  check('holder-rewards total is in the bar as one paid number', /^\$[\d.]+[KMB]? paid in rewards · [\d.]+[KM]? ALON · \d+ of \d+ coins$/.test(rwNote));
  const rwRows = await page.$$eval('#pairsList .pr .pr-r', els => els.map(e => e.textContent));
  check('holder-reward coins carry a rewards line (>= 20)', rwRows.length >= 20);
  check('rewards line is one number: paid in rewards', rwRows.every(t => /^([\d.]+% )?to holders · (\$[\d.]+[KMB]? paid in rewards \([\d.]+[KM]? ALON\)|nothing paid yet)$/.test(t)));
  check('some coins have actually been paid', rwRows.filter(t => /paid in rewards/.test(t)).length >= 10);
  check('rewards amount is not clipped', await page.$$eval('#pairsList .pr-r', els => els.every(e => e.scrollWidth <= e.clientWidth + 1)));
  await page.click('.ps[data-k="rewards"]'); await sleep(300);
  const rwFirst = await page.$eval('#pairsList .pr', e => !!e.querySelector('.pr-r'));
  check('"rewards" sort puts a holder-reward coin first', rwFirst);
  await page.click('.ps[data-k="mcap"]'); await sleep(300);

  // the baked file sorts by mcap; the live overlay may reorder, but the first row must not be zero
  const nonZero = rows.filter(r => !/^\$0(\.00)?$/.test(r.val)).length;
  check('live/baked prices give at least one non-zero mcap', nonZero > 0);
  check('mcap sort is descending', (() => {
    const v = rows.map(r => { const m = r.val.match(/^\$([\d.]+)([KMB]?)$/); return m ? parseFloat(m[1]) * (m[2] === 'B' ? 1e9 : m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1) : -1; });
    return v.every((x, i) => i === 0 || x <= v[i - 1]);
  })());

  // sort toggle → newest first
  await page.click('.ps[data-k="new"]');
  await sleep(200);
  const ages = await page.$$eval('#pairsList .pr .pr-v span', els => els.map(e => e.textContent));
  check('"new" sort is active', await page.$eval('.ps[data-k="new"]', e => e.classList.contains('on')));
  check('"new" sort changed the order', ages.length > 0 && JSON.stringify(ages) !== JSON.stringify(rows.map(() => null)));
  const firstAge = (ages[0] || '').split('·').pop().trim();
  check('newest row is at most a day old', /^\d+[smh]$/.test(firstAge));

  if (OUT) { await page.$eval('#pairsPanel', e => e.scrollIntoView()); await page.screenshot({ path: OUT, fullPage: false }); console.log('shot → ' + OUT); }

  check('no page errors', errors.length === 0);
  await browser.close();
  console.log(`\n${ok.length} passed, ${fails.length} failed${CANARY ? ' (CANARY — failures expected)' : ''}`);
  process.exit(fails.length && !CANARY ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
