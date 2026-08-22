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

  // ---- switchable headline window ----
  const wins = await page.$$eval('#convWin .ws', els => els.map(e => e.dataset.w));
  check('window switcher offers more than one', wins.length > 1);
  check('windows are 7d / 3mo / 6mo', JSON.stringify(wins) === JSON.stringify(['7d', '90d', '180d']));
  check('switcher lives on the band, not inside a card',
        await page.$eval('#convWin', el => el.closest('.conv-card') === null));
  check('only sourceable windows offered', wins.every(w => {
    if (c.hold && c.hold[w] != null) return true;
    if (['7d', '14d', '30d', '180d'].includes(w)) return true;
    return ['30d', '90d', '180d', '365d'].includes(w);   // reconstructable from bucket edges
  }));

  // "exists" is not "visible": the arc renders at a full-circumference dashoffset and the spark
  // bars at zero height, then a rAF reveals both. Deleting that rAF leaves every element in the
  // DOM and every earlier assertion green, with an invisible ring on screen.
  const vis = await page.evaluate(() => {
    const val = document.querySelector('#convCards .conv-ring .val');
    const circ = parseFloat(val.getAttribute('stroke-dasharray'));
    const off = parseFloat(getComputedStyle(val).strokeDashoffset);
    return { arcPct: ((circ - off) / circ) * 100,
             shown: parseFloat(document.querySelector('#convCards .conv-ring span').textContent),
             bars: [...document.querySelectorAll('#convCards .conv-spark i')]
                     .map(i => i.getBoundingClientRect().height) };
  });
  check('ring arc is actually drawn, not fully offset',
        (CANARY ? vis.arcPct < 0.01 : vis.arcPct > 1));
  check('ring arc matches the number it displays', Math.abs(vis.arcPct - vis.shown) < 1.5);
  check('spark bars have real heights', vis.bars.length > 1 && vis.bars.every(h => h > 1));
  check('spark bars are not all identical', new Set(vis.bars.map(Math.round)).size > 1);

  const seen = [];
  for (const w of wins) {
    await page.click(`#convWin .ws[data-w="${w}"]`);
    await sleep(300);
    check(`window ${w} does NOT open the lightbox`, !(await shown()));
    const ring = await page.$eval('#convCards .conv-ring span', e => e.textContent);
    seen.push({ w, days: parseInt(w), pct: parseFloat(ring) });
    // the arc has to follow the switch too, not just the label.
    // .conv-ring .val transitions stroke-dashoffset over 1.2s — read before that settles and
    // you measure the animation, not the result (300ms into a 62->29 switch reads 38.5).
    await sleep(1400);
    const arc = await page.evaluate(() => {
      const v = document.querySelector('#convCards .conv-ring .val');
      const circ = parseFloat(v.getAttribute('stroke-dasharray'));
      return ((circ - parseFloat(getComputedStyle(v).strokeDashoffset)) / circ) * 100;
    });
    check(`window ${w} redraws the arc to match`, Math.abs(arc - parseFloat(ring)) < 1.5);
    check(`window ${w} marks itself active`,
          await page.$eval(`#convWin .ws[data-w="${w}"]`, e => e.classList.contains('on')));
  }
  // a wider window can only ever be a subset — if this ever rises, the windows are wired wrong
  const ordered = [...seen].sort((a, b) => a.days - b.days);
  check('pct falls as the window widens',
        ordered.every((v, i) => i === 0 || (CANARY ? v.pct > ordered[i-1].pct : v.pct <= ordered[i-1].pct)));

  // the selection has to reach the share copy AND the canvas, not just the card
  const pick = wins[wins.length - 1];
  await page.click(`#convWin .ws[data-w="${pick}"]`);
  await sleep(300);
  await page.click('#convCards .conv-card .lab');
  await sleep(800);
  check('card still opens the share card when not hitting a segment', await shown());
  const pickPct = ordered.find(v => v.w === pick).pct;
  check('share text follows the chosen window',
        (await page.$eval('#shareTxt', e => e.textContent)).startsWith(pickPct + '%'));
  await page.keyboard.press('Escape');
  await sleep(300);

  // and it survives a reload
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  check('chosen window persists across reload',
        await page.$eval(`#convWin .ws[data-w="${pick}"]`, e => e.classList.contains('on')));
  await page.evaluate(() => { try { localStorage.removeItem('holdWin'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  check('default for a first-time visitor is 7d',
        await page.$eval('#convWin .ws.on', e => e.dataset.w) === (CANARY ? '180d' : '7d'));

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
  // default headline window is 7d, which the scanner emits directly
  const dflt = (c.hold && c.hold['7d'] != null) ? c.hold['7d'] : c.d7Pct;
  check('line 1 quotes the selected window', lines[0].includes(dflt.toFixed(0) + '%'));
  check('line 1 names the window in words', /hasn't moved in 7 days/.test(lines[0]));
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
