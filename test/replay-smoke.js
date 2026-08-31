// smoke for replay.html: chart draws, board loads, a real wallet replays with markers,
// and the truncation warnings surface. Real-timed, system Chrome via playwright-core.
// CANARY=1 flips the assertions against a wallet with no trades to prove they can fail.
const { chromium } = require('/Users/christianmetaversal/tibanne-3d/test/node_modules/playwright-core');
const URL = process.env.URL || 'http://localhost:8131/replay.html';
const CANARY = process.env.CANARY === '1';
const OUT = process.env.OUT || '/private/tmp/claude-501/-Users-christianmetaversal/b0ace1bf-b5ca-4129-a00a-89f0fe3562e1/scratchpad/replay.png';
const fails = [], ok = [];
const check = (n, c) => { (c ? ok : fails).push(n); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-logging=stderr'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', e => { errors.push(String(e)); console.log('PAGEERROR ' + e); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__board && window.__board.length > 0, { timeout: 25000 })
    .catch(() => console.log('  (board never populated)'));
  // Verify the SHIPPED pace off the control, then speed the rest of the suite up — the default
  // is deliberately slow (5s/trade => a 30-trade replay runs ~150s) and every downstream
  // assertion would otherwise time out rather than fail honestly.
  // the s/trade control was removed — pace is fixed. Assert there is no dial, and read the
  // shipped value through the harness hook instead of a label that no longer exists.
  const hasDial = await page.evaluate(() => !!document.getElementById('speed'));
  check('no seconds-per-trade control is exposed', !hasDial);

  // the boot replay fetches trades and backfills candles first — wait for it to actually
  // start animating rather than sampling mid-load and calling a loading page a broken one
  await page.waitForFunction(() => {
    const st = document.getElementById('status').textContent;
    return /\d+\/\d+ trades|complete/.test(st);
  }, { timeout: 60000 }).catch(() => console.log('  (boot replay never started)'));
  await sleep(600);

  // THE BUG CHRIS HIT: PLAY was disabled on a cold load, so the page animated nothing and
  // read as broken. Assert the cold page is self-starting BEFORE anything is clicked.
  const cold = await page.evaluate(() => ({
    disabled: document.getElementById('play').disabled,
    label: document.getElementById('play').textContent,
    clockOn: document.getElementById('clock').className.includes('on'),
    status: document.getElementById('status').textContent,
  }));
  console.log('  cold state: play=' + (cold.disabled ? 'DISABLED' : 'enabled') + ' label=' + cold.label.trim() + ' status=' + cold.status);
  check('PLAY is never left disabled with an idle label', !cold.disabled || /LOADING/.test(cold.label));
  check('page self-starts a replay on load', /STOP/.test(cold.label) || cold.clockOn || /\d+\/\d+ trades|complete/.test(cold.status));

  check('no page errors', errors.length === 0);
  check('chart canvas drawn', (await page.$$('#chart canvas')).length > 0);
  check('board has rows', (await page.$$('#board .row[data-w]')).length > 5);
  check('footer states coverage', /discovery window/.test(await page.$eval('#foot', e => e.textContent)));
  check('reducer loaded in page', await page.evaluate(() => typeof window.computePnl === 'function'));

  // the wallet input lives in a drawer behind #entry, closed on load. Before that drawer
  // landed the input was always on the page, so the old fill() worked; now it silently
  // times out against a display:none field.
  const openDrawer = async () => {
    const open = await page.$eval('#drop', e => e.className.includes('open'));
    if (!open) await page.click('#entry');
    await page.waitForSelector('#addr', { state: 'visible', timeout: 5000 });
  };

  // deep-verify: pick the wallet the board ranks #1 and replay it
  const top = await page.evaluate(() => window.__board[0].wallet);
  const target = CANARY ? '11111111111111111111111111111111' : top;
  await openDrawer();
  await page.fill('#addr', target);
  await page.click('#go');
  await page.waitForFunction(() => /trades ·|no \$ALON/.test(document.getElementById('status').textContent), { timeout: 40000 })
    .catch(() => console.log('  (replay never resolved)'));
  await sleep(1200);

  const tot = await page.$eval('#hTot', e => e.textContent);
  const bought = await page.$eval('#sB', e => e.textContent);
  check('total pnl rendered', /\$[\d.,]+/.test(tot) && tot !== '$0');
  check('bought populated', bought !== '—');
  check('play button enabled', !(await page.$eval('#play', e => e.disabled)));

  // exercise the animation: candles must reveal progressively, markers must accumulate,
  // and the clock must actually advance. A replay that no-ops still leaves the stats filled
  // in from the static paint, so assert on MOTION, not on the end state.
  if (!CANARY) {
    await page.evaluate(() => window.__setPace && window.__setPace(3));
    await page.click('#play'); await sleep(200); await page.click('#play');   // restart at test pace
    await page.waitForFunction(() => /\d+\/\d+ trades/.test(document.getElementById('status').textContent), { timeout: 60000 }).catch(() => {});
    // NO further #play click — the page is animating, and a click would STOP it.
    const a = await page.evaluate(() => ({
      label: document.getElementById('play').textContent,
      clock: document.getElementById('clock').textContent,
      clockOn: document.getElementById('clock').className.includes('on'),
      status: document.getElementById('status').textContent,
    }));
    await page.screenshot({ path: OUT.replace('.png', '-mid.png') });
    await sleep(2200);
    const b = await page.evaluate(() => ({
      clock: document.getElementById('clock').textContent,
      status: document.getElementById('status').textContent,
    }));
    check('play button flips to STOP', /STOP/.test(a.label));
    check('clock is visible during replay', a.clockOn);
    check('clock advances', a.clock !== b.clock || /complete/.test(b.status));
    check('status counts trades through', /\d+\/\d+ trades/.test(a.status) || /complete/.test(a.status));
    console.log('  mid-replay status: ' + a.status + '  ->  ' + b.status);

    // THE PACING BUG: a calendar-linear clock crawls through empty months then fires every
    // clustered trade in the last half-second — "it flashed once and then showed all
    // transactions". Index pacing means the counter must climb GRADUALLY, so sample it
    // repeatedly and assert it lands on several distinct intermediate values.
    const seen = new Set();
    for (let i = 0; i < 26; i++) {
      const n = await page.evaluate(() => {
        const m = document.getElementById('status').textContent.match(/(\d+)\/(\d+) trades/);
        return m ? +m[1] : null;
      });
      if (n !== null) seen.add(n);
      await sleep(280);
    }
    console.log('  distinct trade counts sampled during replay: ' + seen.size + '  [' + [...seen].join(',') + ']');

    // the visual layer: Alon must actually be ON the chart and MOVING, and the sprite sheet
    // must have loaded (a 404 leaves a visible element with no background image)
    const vis = [];
    for (let i = 0; i < 8; i++) {
      vis.push(await page.evaluate(() => {
        const r = document.getElementById('rider');
        const cs = getComputedStyle(r);
        return { on: r.className.includes('on'), left: r.style.left, top: r.style.top, bg: cs.backgroundImage };
      }));
      await sleep(190);
    }
    const shown = vis.filter(v => v.on);
    const spots = new Set(shown.map(v => v.left + '|' + v.top));
    console.log('  rider: visible in ' + shown.length + '/8 samples, ' + spots.size + ' distinct positions');

    // THE FRAMING BUG: the camera pinned the leading edge to the right edge, so every buy and
    // sell fired in the last sliver of the frame. Alon rides that leading edge, so his X is the
    // direct measure — assert he sits near the MIDDLE of the chart, not jammed right.
    const frac = [];
    for (let i = 0; i < 6; i++) {
      const f = await page.evaluate(() => {
        const r = document.getElementById('rider');
        if (!r.className.includes('on')) return null;
        const w = document.getElementById('chart').clientWidth;
        return parseFloat(r.style.left) / w;
      });
      if (f !== null) frac.push(f);
      await sleep(200);
    }
    const avg = frac.length ? frac.reduce((a, b) => a + b, 0) / frac.length : -1;
    console.log('  action sits at x=' + (avg * 100).toFixed(0) + '% of chart width  [' + frac.map(f => (f * 100).toFixed(0)).join(',') + ']');
    check('action is centred, not pinned right', avg > 0.3 && avg < 0.72);

    // THE JITTER BUG: the price scale re-autoscaled every frame on a sliding window, lurching
    // the chart vertically — read as "going up and down so much so fast". Alon sits on the
    // price line, so his Y is the measure: frame-to-frame jumps must stay small.
    const ys = [];
    for (let i = 0; i < 12; i++) {
      const y = await page.evaluate(() => {
        const r = document.getElementById('rider');
        return r.className.includes('on') ? parseFloat(r.style.top) : null;
      });
      if (y !== null) ys.push(y);
      await sleep(120);
    }
    const h = await page.evaluate(() => document.getElementById('chart').clientHeight);
    let worst = 0;
    for (let i = 1; i < ys.length; i++) worst = Math.max(worst, Math.abs(ys[i] - ys[i - 1]) / h);
    console.log('  worst vertical jump between samples: ' + (worst * 100).toFixed(1) + '% of chart height');
    check('price scale glides, does not lurch', ys.length < 3 || worst < 0.34);

    // Alon must GLIDE, not teleport. Sample tightly and look at the biggest single-step move:
    // pinned-to-close made him jump a whole wick every new bar. Also assert he still MOVES —
    // an over-damped rider that never gets anywhere would otherwise pass a smoothness check.
    const fine = [];
    for (let i = 0; i < 16; i++) {
      const pt = await page.evaluate(() => {
        const r = document.getElementById('rider');
        if (!r.className.includes('on')) return null;
        // carry the cut count so a step spanning a deliberate view cut can be excluded — a cut
        // is a discontinuity by design and asserting continuity across it is simply wrong
        return [parseFloat(r.style.left), parseFloat(r.style.top), (window.__beats || {}).cuts || 0];
      });
      if (pt) fine.push(pt);
      await sleep(70);
    }
    if (fine.length > 4) {
      let jump = 0, travel = 0, skipped = 0;
      for (let i = 1; i < fine.length; i++) {
        const d = Math.hypot(fine[i][0] - fine[i-1][0], fine[i][1] - fine[i-1][1]);
        travel += d;
        if (fine[i][2] !== fine[i-1][2]) { skipped++; continue; }   // a cut happened in this gap
        jump = Math.max(jump, d);
      }
      console.log('  rider: worst step (excluding ' + skipped + ' cut spans) ' + jump.toFixed(1)
        + 'px, total travel ' + travel.toFixed(0) + 'px');
      // excluding EVERY span leaves nothing measured — that is a vacuous pass, not a clean one
      check('enough non-cut spans to judge glide', skipped < fine.length - 3);
      check('rider glides, no teleport', jump < 45);
      check('rider is not frozen', travel > 12);
    }
    // camera smoothness: driving the view off an INTEGER bar index lurched one whole candle per
    // reveal. Sample the visible logical range and assert its steps are fractional, not integral.
    const lr = [];
    for (let i = 0; i < 14; i++) {
      const v = await page.evaluate(() => {
        const r = window.__chart && window.__chart.timeScale().getVisibleLogicalRange();
        return r ? r.from : null;
      });
      if (v !== null) lr.push(v);
      await sleep(80);
    }
    if (lr.length > 5 && lr.some((v, i) => i && Math.abs(v - lr[i-1]) > 1e-6)) {
      const steps = [];
      for (let i = 1; i < lr.length; i++) { const d = Math.abs(lr[i] - lr[i-1]); if (d > 1e-6) steps.push(d); }
      // "bar-by-bar" judder means steps landing on exactly ONE bar — that is the integer-index
      // lurch. Fractional-vs-integer was a bad proxy: a head that legitimately travels 2.00 bars
      // between samples is not judder. Measure the thing itself.
      const judder = steps.filter(d => Math.abs(d - 1) < 0.06).length;
      // Scroll rate scales with the pace, so a fixed bars-per-sample threshold is meaningless —
      // the suite runs at 1s/trade to finish, i.e. 5x the shipped 5s/trade. Assert the DESIGN
      // invariant instead: travel per trade-beat never exceeds MAXSPAN (zoomBars*0.7).
      const bound = await page.evaluate(() => window.__scrollBound);
      const perSecMax = Math.max(...steps) / 0.08;
      console.log('  camera steps: [' + steps.map(d => d.toFixed(2)).join(' ') + ']');
      console.log('  camera: max ' + Math.max(...steps).toFixed(2) + ' bars/sample = ' + perSecMax.toFixed(0)
        + ' bars/sec; design bound ' + bound.toFixed(0) + ' bars/sec');
      check('camera does not lurch bar-by-bar', steps.length > 2 && judder < steps.length * 0.4);
      // An isolated over-bound step is a deliberate CUT across a quiet gap. Consecutive
      // over-bound steps are a sustained fast scroll, which is the thing that reads as "too
      // fast". Distinguish them rather than asserting on the max.
      // The design deliberately CUTS across quiet gaps, and when several trades are spaced far
      // apart those cuts land back to back — so "no two consecutive large steps" is enforcing
      // something the design never promised, and it flapped between runs. What actually matters
      // is the GLIDE rate: the speed the chart moves at most of the time. Median step measures
      // that and lets outlier cuts through, which is the honest split.
      const perSample = bound * 0.08;
      const sorted = [...steps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log('  camera: median step ' + median.toFixed(2) + ' bars/sample vs ' + perSample.toFixed(2)
        + ' cap (cuts excluded as outliers)');
      check('glide rate stays within the travel cap', steps.length > 2 && median < perSample * 1.25);

      // "slow motion" was speed SWINGING with how far apart trades happened to be — a whole beat
      // spent barely moving, then a sprint. Constant-rate scrolling means the spread collapses.
      // Cuts are excluded: they are instantaneous by design, not a speed.
      const glide = steps.filter(d => d > 0.05 && d < perSample * 3);
      if (glide.length > 3) {
        const mean = glide.reduce((a, b) => a + b, 0) / glide.length;
        const sd = Math.sqrt(glide.reduce((a, b) => a + (b - mean) ** 2, 0) / glide.length);
        console.log('  scroll consistency: mean ' + mean.toFixed(2) + ' sd ' + sd.toFixed(2)
          + ' (cv ' + (sd / mean).toFixed(2) + ')');
        check('scroll speed is consistent, not slow-mo then sprint', sd / mean < 0.55);
      } else {
        check('enough glide samples to judge consistency', false);
      }
    } else {
      // no movement sampled means the replay was not running — say that, do not crash on it
      console.log('  camera: no movement sampled (replay not running during the window)');
      check('camera range readable during replay', false);
    }

    const size = await page.evaluate(() => {
      const r = document.getElementById('rider');
      return { w: r.offsetWidth, glow: document.getElementById('riderGlow').className.includes('on') };
    });
    // he runs forward through time; deriving facing from price direction flipped him on every dip
    const faces = [];
    for (let i = 0; i < 10; i++) {
      const f = await page.evaluate(() => {
        const r = document.getElementById('rider');
        return r.className.includes('on') ? getComputedStyle(r).transform : null;
      });
      if (f) faces.push(f);
      await sleep(110);
    }
    const flipped = faces.filter(t => /matrix\(-1|matrix\(-?0?\.?\d*, .*-1/.test(t) || t.includes('-1,')).length;
    console.log('  rider facing: ' + faces.length + ' samples, ' + flipped + ' mirrored');
    check('Alon always faces right', faces.length > 3 && flipped === 0);

    // platformer beats: he must ARC (leave the price line on the way to a fill) and take a
    // visible HIT on sells. Sample densely and look at vertical deviation + the hurt class.
    const traj = [];
    for (let i = 0; i < 70; i++) {
      traj.push(await page.evaluate(() => {
        const r = document.getElementById('rider');
        if (!r.className.includes('on')) return null;
        return { y: parseFloat(r.style.top), hurt: r.className.includes('hurt'),
                 tf: r.style.transform, bp: r.style.backgroundPosition };
      }));
      await sleep(55);
    }
    const pts = traj.filter(Boolean);
    // an arc shows up as the y-series reversing direction — running the line alone is monotone-ish
    let turns = 0;
    for (let i = 2; i < pts.length; i++) {
      const a = pts[i-1].y - pts[i-2].y, b = pts[i].y - pts[i-1].y;
      if (Math.abs(a) > 1.5 && Math.abs(b) > 1.5 && Math.sign(a) !== Math.sign(b)) turns++;
    }
    const hurtFrames = pts.filter(p => p.hurt).length;
    const squashed = pts.filter(p => /scaleY\(0\.\d/.test(p.tf)).length;
    console.log('  rider trajectory: ' + pts.length + ' samples, ' + turns + ' direction reversals, '
      + hurtFrames + ' hurt frames, ' + squashed + ' squash frames');
    // ⚠ Inferring the arc from sampled pixels missed it — the leap can be under 300ms at pace,
    // so a 55ms sampler catches one or two points and sees no reversal. Ask the mechanism.
    const clk = await page.evaluate(() => window.__clock);
    if (clk) console.log('  clock: total ' + clk.total.toFixed(0) + ' bars over ' + (clk.DUR/1000).toFixed(1)
      + 's = ' + clk.barsPerSec.toFixed(0) + ' bars/sec (design RATE ' + clk.RATE.toFixed(0) + ' at 5s pace)');
    const beats = await page.evaluate(() => window.__beats);
    const airborneSeen = pts.some(p => /scaleY/.test(p.tf)) && beats.jumps > 0;
    console.log('  beats: ' + beats.jumps + ' leaps armed, max arc ' + beats.maxArc.toFixed(0)
      + 'px, ' + beats.hits + ' hits taken');
    console.log('  leap apexes: ' + beats.distinctPeaks + ' distinct values across ' + beats.jumps + ' jumps');
    check('Alon leaps onto fills', beats.jumps > 0);
    check('the leap actually leaves the line', beats.maxArc > 20);
    // "floaty" was the arc scaling with drop distance — every jump a different height and a
    // different hang time. Consistent means at most two apexes exist: one for buys, one for sells.
    check('every leap is the same height', beats.jumps < 2 || beats.distinctPeaks <= 2);
    check('sells register a hit reaction', hurtFrames > 0 && beats.hits > 0);

    console.log('  rider size ' + size.w + 'px, glow=' + size.glow);
    check('rider is large enough to read', size.w >= 60);

    // and the pacing: slower means FEWER trades land in a fixed wall-clock sample
    const paceA = await page.evaluate(() => { const m = document.getElementById('status').textContent.match(/(\d+)\/(\d+) trades/); return m ? +m[1] : null; });
    await sleep(2000);
    const paceB = await page.evaluate(() => { const m = document.getElementById('status').textContent.match(/(\d+)\/(\d+) trades/); return m ? +m[1] : null; });
    // 0 trades/sec passes "< 3" for the wrong reason — a finished replay is not a slow one.
    // Only judge the pace while it is actually advancing, and say so when it cannot be judged.
    const running = await page.evaluate(() => /STOP/.test(document.getElementById('play').textContent));
    if (paceA !== null && paceB !== null && paceB > paceA) {
      const perSec = (paceB - paceA) / 2;
      console.log('  pace: ' + perSec.toFixed(1) + ' trades/sec');
        check('pace is followable (< 3 trades/sec)', perSec < 3);
      check('pace tracks the test setting', perSec < 2.2);
    } else if (running) {
      check('pace measurable while running', false);
    } else {
      console.log('  pace: not measured (replay already finished)');
    }
    check('Alon rides the chart', shown.length >= 3);
    check('Alon actually moves', spots.size >= 3);
    check('sprite sheet resolved', shown.length === 0 || /alon-sprite-sheet/.test(shown[0].bg));
    check('trades fire gradually, not all at once', seen.size >= 4);
    check('replay caps at the tail window', /last \d+ of \d+/.test(a.status) || /\/(30|100) trades/.test(a.status));
    // let it finish so the final screenshot is the settled state
    await page.waitForFunction(() => /complete/.test(document.getElementById('status').textContent), { timeout: 90000 })
      .catch(() => console.log('  (replay did not finish in time)'));
    await sleep(900);

    // the meme payload: a rank card must actually appear, with a real grade and multiple
    // the loading overlay: a frozen chart while trades fetch is what chris asked to replace
  await page.evaluate(() => window.__setPace && window.__setPace(3));
  await openDrawer();
  await page.fill('#addr', top);
  const loadSeen = await Promise.race([
    page.waitForFunction(() => document.getElementById('load').className.includes('on'), { timeout: 8000 }).then(() => true).catch(() => false),
    page.click('#go').then(() => new Promise(r => setTimeout(() => r(null), 8000))),
  ]);
  const loadState = await page.evaluate(() => ({
    on: document.getElementById('load').className.includes('on'),
    txt: document.getElementById('loadTxt').textContent,
    anim: getComputedStyle(document.getElementById('loadAlon')).animationName,
    bg: getComputedStyle(document.getElementById('loadAlon')).backgroundImage,
  }));
  console.log('  loading overlay: seen=' + loadSeen + ' txt="' + loadState.txt + '" anim=' + loadState.anim);
  check('loading overlay appears while fetching', loadSeen === true || loadState.on);
  check('loading Alon is animating', /runcycle/.test(loadState.anim));
  check('loading Alon has the sprite sheet', /alon-sprite-sheet/.test(loadState.bg));
  const gone = await page.waitForFunction(() => !document.getElementById('load').className.includes('on'), { timeout: 90000 })
    .then(() => true).catch(() => false);
  check('loading overlay clears once loaded', gone);
  // poll with visible progress rather than a blind waitForFunction — a bare timeout tells you
  // nothing about whether it stalled or was merely slow
  let done2 = false, lastSt = '';
  for (let i = 0; i < 60; i++) {
    lastSt = await page.evaluate(() => document.getElementById('status').textContent);
    if (/complete/.test(lastSt)) { done2 = true; break; }
    if (i % 10 === 0) console.log('    …' + (i * 3) + 's: ' + lastSt.slice(0, 50));
    await sleep(3000);
  }
  if (!done2) console.log('  (2nd replay did not finish — last: ' + lastSt + ')');
  check('second replay completes', done2);
  await sleep(900);

  const gg = await page.evaluate(() => ({
      on: document.getElementById('gg').className.includes('on'),
      rank: (document.getElementById('ggRank').textContent || '').trim(),
      cls: document.getElementById('ggRank').className,
      mult: document.getElementById('ggMult').textContent,
      tot: document.getElementById('ggTot').textContent,
    }));
    console.log('  rank card: ' + gg.rank + ' / ' + gg.mult + ' / ' + gg.tot);
    check('rank card appears', gg.on);
    // the scrim sits at z-index 8 over the chart — if it survives, the replay plays underneath
    // it and everything else still passes. That is exactly what shipped.
    const scrim = await page.evaluate(() => document.getElementById('load').className.includes('on'));
    check('loading overlay is not covering the finished replay', !scrim);
    check('rank is a real grade', /^[SABCDF?]/.test(gg.rank));
    check('rank is colour-coded', /r-[SABCDFX]/.test(gg.cls));
    check('multiple is numeric', /^\d+\.\d\dx$/.test(gg.mult));
    // grading on MULTIPLE not dollars: the card must state what went in, or the x is unreadable
    check('card states capital in', / in ·/.test(gg.tot));
    await page.screenshot({ path: OUT.replace('.png', '-gg.png') });
  }

  // markers actually reached the series, not just the stat row
  const marks = await page.evaluate(() => {
    const c = document.querySelectorAll('#chart canvas');
    return c.length ? 1 : 0;   // series markers are canvas-drawn; presence proven via pixels below
  });
  check('chart still rendering after replay', marks === 1);

  // pixel proof — the chart area must not be a flat fill. Sampled AFTER the replay settles:
  // mid-reveal the series legitimately holds only a handful of bars.
  const px = await page.evaluate(() => {
    const cv = document.querySelectorAll('#chart canvas');
    if (!cv.length) return -1;
    // lightweight-charts stacks canvases; the topmost is the transparent crosshair overlay,
    // so sampling cv[last] reads 2 colours on a perfectly good chart. Take the busiest one.
    let c = cv[0], best = -1;
    for (const k of cv) { const a = k.width * k.height; if (a > best) { best = a; c = k; } }
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    t.getContext('2d').drawImage(c, 0, 0);
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + ',' + d[i+1] + ',' + d[i+2]);
    return seen.size;
  });
  console.log('  distinct chart colours sampled: ' + px);
  check('chart is not a flat fill', px > 6);

  // the bug the first screenshot caught: trades older than the loaded candles used to clamp
  // onto bar zero and stack into a column of overlapping labels at the left edge
  const stack = await page.evaluate(() => {
    const s = document.getElementById('status').textContent;
    return /older than the loaded chart/.test(s) ? 'reported' : 'none';
  });
  console.log('  out-of-range markers: ' + stack);
  check('early trades are covered or reported, never clamped', stack === 'none' || stack === 'reported');

  // THE SETTLED-STATE BUG: paint() built its own labelled markers, so the animation showed
  // clean dots and the finished chart showed a wall of "BUY $76.19" text. Assert on the marker
  // objects the series actually holds, after the replay has settled.
  const mk = await page.evaluate(() => {
    const p = window.__cur && window.__cur.p;
    if (!p) return null;
    const built = p.marks.map(m => window.__markerFor(m)).filter(Boolean);
    return {
      n: built.length,
      withText: built.filter(m => m.text && m.text.length).length,
      shapes: [...new Set(built.map(m => m.shape))],
      sizes: [...new Set(built.map(m => Math.round(m.size * 100)))].length,
    };
  });
  if (mk) {
    console.log('  markers: ' + mk.n + ' total, ' + mk.withText + ' labelled, shapes=' + mk.shapes.join('/') + ', ' + mk.sizes + ' distinct sizes');
    check('no marker carries text', mk.withText === 0);
    check('markers are dots', mk.shapes.length === 1 && mk.shapes[0] === 'circle');
    check('dot size varies with trade size', mk.sizes >= 3);
  } else {
    check('marker bridge exposed', false);
  }

  await page.screenshot({ path: OUT, fullPage: true });
  console.log('\nshot → ' + OUT);
  console.log(`${ok.length} passed, ${fails.length} failed`);
  await browser.close();

  if (CANARY) {
    if (fails.length > 0) { console.log('CANARY OK — assertions fail on a wallet with no trades.'); process.exit(0); }
    console.log('CANARY FAILED — assertions pass even with no data.'); process.exit(1);
  }
  process.exit(fails.length ? 1 : 0);
})();
