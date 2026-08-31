// Wallet replay engine — drives an EXISTING lightweight-charts series rather than creating one.
//
// The first integration embedded replay.html in an iframe, which meant the site showed two
// charts stacked. chris: "i dont like that a new chart shows up entirely. can it not use the
// same chart that is already there?" It can — the host hands over its chart + candle series and
// the engine takes them over for the duration, then hands them back.
//
//   const rp = ReplayEngine({ stage, chart, series, getSupply, getPrice, onStatus, onEnd });
//   await rp.play(walletAddress);
//   rp.stop();
//
// The engine builds its own overlay DOM inside `stage` (Alon, glow, particles, flash, rank card)
// so a host only has to supply the chart, never 30 element ids.
//
// ⚠ The host MUST suspend its own chart refresh while a replay runs, and repaint on onEnd —
// otherwise a 30s poll wipes the replay mid-animation.

(function () {
  const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
  const JUP_TXS = 'https://datapi.jup.ag/v1/txs';
  const JUP_CHART = 'https://datapi.jup.ag/v2/charts';

  const fmt = v => { const a = Math.abs(v), s = v < 0 ? '-' : '';
    return a >= 1e9 ? s+'$'+(a/1e9).toFixed(2)+'B' : a >= 1e6 ? s+'$'+(a/1e6).toFixed(2)+'M'
         : a >= 1e3 ? s+'$'+(a/1e3).toFixed(1)+'K' : s+'$'+a.toFixed(2); };
  const short = a => a.slice(0, 4) + '…' + a.slice(-4);
  const sz = usd => Math.min(1, Math.log10(Math.max(usd, 1) + 1) / 4.6);
  const mmss = ms => { const s = Math.floor(ms/1000); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

  const CSS = `
.rpx{position:absolute;inset:0;pointer-events:none;z-index:30;font-family:ui-monospace,'SF Mono',Menlo,monospace}
.rpx.off{display:none}
.rpx .rider{position:absolute;width:74px;height:74px;image-rendering:pixelated;display:none;
 background:url('alon-sprite-sheet.png?v=1') 0 0 / 600% 100% no-repeat;
 filter:drop-shadow(0 0 3px rgba(11,13,14,.95)) drop-shadow(0 0 22px rgba(74,222,128,.85)) drop-shadow(0 4px 8px rgba(0,0,0,.85));
 transform:translate(-50%,-96%);transform-origin:50% 100%;will-change:left,top;z-index:3}
.rpx .rider.on{display:block}
.rpx .rider.hurt{filter:drop-shadow(0 0 3px rgba(11,13,14,.95)) drop-shadow(0 0 20px rgba(248,113,113,.95))
 saturate(.35) brightness(1.5) sepia(.6) hue-rotate(-35deg);animation:rpblink .12s steps(2) infinite}
@keyframes rpblink{0%{opacity:1}100%{opacity:.35}}
.rpx .glow{position:absolute;width:120px;height:120px;display:none;transform:translate(-50%,-50%);z-index:2;
 background:radial-gradient(circle,rgba(74,222,128,.30),transparent 68%)}
.rpx .glow.on{display:block}
.rpx .glow.hurt{background:radial-gradient(circle,rgba(248,113,113,.42),transparent 68%)}
.rpx canvas.burst{position:absolute;inset:0;z-index:2}
.rpx .flash{position:absolute;inset:0;opacity:0;z-index:1;background:radial-gradient(circle at 50% 60%,rgba(74,222,128,.30),transparent 62%)}
.rpx .flash.red{background:radial-gradient(circle at 50% 60%,rgba(248,113,113,.28),transparent 62%)}
.rpx .flash.hit{animation:rpfl .42s ease-out}
@keyframes rpfl{0%{opacity:1}100%{opacity:0}}
.rpx .hud{position:absolute;top:10px;left:14px;right:14px;display:flex;justify-content:space-between;
 align-items:flex-start;gap:12px;z-index:4}
.rpx.done .hud .who{opacity:0}
.rpx .who{font-size:11px;color:#7d8b83}
.rpx .who b{display:block;font-size:13px;color:#e9f2ec;font-weight:800}
.rpx .tot{font-size:34px;font-weight:900;letter-spacing:-.03em;font-variant-numeric:tabular-nums;text-align:right;line-height:1}
.rpx .tot.up{color:#4ade80;text-shadow:0 0 30px rgba(74,222,128,.45)}
.rpx .tot.down{color:#f87171;text-shadow:0 0 30px rgba(248,113,113,.4)}
.rpx .totk{font-size:8.5px;letter-spacing:.22em;color:#5a6862;text-align:right;margin-top:2px}
.rpx .clock{position:absolute;top:12px;left:50%;transform:translateX(-50%);font-size:11px;
 color:#4ade80;border:1px solid #16a34a;border-radius:4px;padding:2px 8px;z-index:4;display:none}
.rpx .clock.on{display:block}
.rpx .combo{position:absolute;top:56px;left:16px;font-weight:900;font-size:22px;color:#4ade80;
 text-shadow:0 0 16px rgba(74,222,128,.6);opacity:0;z-index:4}
.rpx .combo.pop{animation:rpcp .5s ease-out}
@keyframes rpcp{0%{opacity:0;transform:translateY(8px) scale(.8)}22%{opacity:1;transform:none scale(1.16)}100%{opacity:0;transform:translateY(-14px)}}
.rpx .warn{position:absolute;left:0;right:0;bottom:0;padding:8px 12px;font-size:10.5px;line-height:1.5;
 background:#2a1f06;color:#fbbf24;z-index:4;display:none}
.rpx .warn.on{display:block}
.rpx .load{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;
 gap:12px;background:rgba(8,11,12,.88);z-index:6}
.rpx .load.on{display:flex}
.rpx .load i{width:74px;height:74px;image-rendering:pixelated;display:block;
 background:url('alon-sprite-sheet.png?v=1') 0 0 / 600% 100% no-repeat;
 filter:drop-shadow(0 0 20px rgba(74,222,128,.7));animation:rprun .6s steps(6) infinite,rpbob .6s ease-in-out infinite}
@keyframes rprun{from{background-position:0% 0}to{background-position:120% 0}}
@keyframes rpbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
.rpx .load b{font-size:12px;letter-spacing:.28em;color:#4ade80;font-weight:800}
.rpx .load s{font-size:10px;letter-spacing:.14em;color:#5a6862;text-decoration:none;min-height:13px}
.rpx .gg{position:absolute;top:52px;left:14px;display:none;flex-direction:column;align-items:flex-start;
 gap:2px;z-index:7;text-align:left;pointer-events:auto;padding:13px 15px 12px;border-radius:11px;
 background:rgba(11,14,15,.90);border:1px solid #2e3637;box-shadow:0 14px 44px rgba(0,0,0,.7);
 max-width:250px;transform-origin:18% 30%}
/* ⚠ NO full-bleed scrim. The end state exists so you can see every buy and sell at once, and a
   veil over the chart is the one thing that defeats it. Card sits over the top-left dead space. */
.rpx .gg.on{display:flex;animation:rpslam 1.05s cubic-bezier(.18,1.5,.4,1) forwards}
/* same slam curve as .pump-pop in index.html — overshoot, counter-rotate, settle */
@keyframes rpslam{
  0%{transform:scale(.25) rotate(-9deg);opacity:0}
  18%{transform:scale(1.14) rotate(2.5deg);opacity:1}
  30%{transform:scale(.97) rotate(-1.5deg)}
  42%{transform:scale(1.02) rotate(.6deg)}
  100%{transform:scale(1) rotate(0);opacity:1}
}
.rpx .gg .rk{font-size:52px;font-weight:900;line-height:.86;letter-spacing:-.05em}
.rpx .gg .rk small{display:block;font-size:8px;letter-spacing:.3em;color:#5a6862;margin-top:5px}
.rpx .gg .mx{font-size:23px;font-weight:900;margin-top:7px;letter-spacing:-.02em}
.rpx .gg .sub{font-size:10.5px;color:#7d8b83;margin-top:3px;line-height:1.45}
.rpx .gg .adr{font-size:8.5px;color:#5a6862;margin-top:7px;white-space:nowrap}
.rpx .gg .brand{font-size:7.5px;letter-spacing:.26em;color:#5a6862;margin-top:9px}
.rpx .gg .btns{display:flex;gap:6px;margin-top:11px}
.rpx .gg button{font-size:9.5px;padding:6px 10px;white-space:nowrap}
.rpx .gg button{font-family:inherit;font-size:10.5px;letter-spacing:.08em;padding:8px 13px;border-radius:7px;
 cursor:pointer;background:#191e1f;border:1px solid #2e3637;color:#e9f2ec}
.rpx .gg button:hover{border-color:#16a34a;color:#4ade80}
.rpx .lb{position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;
 background:rgba(4,7,7,.82);backdrop-filter:blur(3px);pointer-events:auto;padding:22px}
.rpx .lb.on{display:flex;animation:rplbin .22s ease-out}
@keyframes rplbin{from{opacity:0}to{opacity:1}}
.rpx .lb .card{background:#131718;border:1px solid #232a2b;border-radius:13px;padding:13px;
 max-width:min(94vw,940px);max-height:92vh;display:flex;flex-direction:column;gap:11px;
 box-shadow:0 26px 80px rgba(0,0,0,.8)}
.rpx .lb img{max-width:100%;max-height:66vh;border-radius:8px;display:block;border:1px solid #232a2b}
.rpx .lb .tools{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.rpx .lb .cap{font-size:9.5px;color:#5a6862;letter-spacing:.06em;margin-left:auto}
.rpx .lb button{font-family:inherit;font-size:10.5px;letter-spacing:.08em;font-weight:700;
 padding:9px 13px;border-radius:7px;cursor:pointer;background:#191e1f;border:1px solid #2e3637;color:#e9f2ec}
.rpx .lb button:hover{border-color:#16a34a;color:#4ade80}
.rpx .lb button.primary{background:#16a34a;border-color:#16a34a;color:#04150c}
.rpx .lb button.primary:hover{background:#4ade80;color:#04150c}
.rpx .rS{color:#fbbf24;text-shadow:0 0 30px rgba(251,191,36,.55)}.rpx .rA{color:#4ade80;text-shadow:0 0 26px rgba(74,222,128,.5)}
.rpx .rB{color:#38bdf8;text-shadow:0 0 22px rgba(56,189,248,.45)}.rpx .rC{color:#c9ffdd}
.rpx .rD{color:#7d8b83}.rpx .rX{color:#7d8b83}.rpx .rF{color:#f87171;text-shadow:0 0 26px rgba(248,113,113,.5)}
`;

  // the ladder lives in tools/pnl.js so the replay and the leaderboard grade identically
  const rankOf = p => window.convictionRank(p);
  const rcls = r => (r === '?' ? 'X' : r);        // '?' is not a legal CSS class

  const PFP = new Image(); PFP.src = 'alon-pfp.jpg?v=1';

  window.ReplayEngine = function (host) {
    const { stage, chart, series } = host;
    const getSupply = host.getSupply || (() => 1);
    const getPrice = host.getPrice || (() => 0);
    const onStatus = host.onStatus || (() => {});
    const onEnd = host.onEnd || (() => {});
    const onBegin = host.onBegin || (() => {});

    if (!document.getElementById('rpx-css')) {
      const st = document.createElement('style'); st.id = 'rpx-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }

    const ov = document.createElement('div');
    ov.className = 'rpx off';
    ov.innerHTML =
      '<div class="flash"></div><canvas class="burst"></canvas><div class="glow"></div><div class="rider"></div>' +
      '<div class="hud"><div class="who"><b></b><span></span></div>' +
      '<div><div class="tot">$0</div><div class="totk">TOTAL PNL</div></div></div>' +
      '<div class="clock">0:00</div><div class="combo"></div><div class="warn"></div>' +
      '<div class="load"><i></i><b>LOADING TRADES</b><s></s></div>' +
      '<div class="gg"><div class="rk">S<small>RANK</small></div><div class="mx">0.0x</div>' +
      '<div class="sub"></div><div class="adr"></div><div class="brand">$ALON · ALONPUMP.RUN</div>' +
      '<div class="btns"><button class="again">↻ AGAIN</button><button class="copy">COPY</button>' +
      '<button class="close">CLOSE</button></div></div>' +
      '<div class="lb"><div class="card"><img alt="shareable $ALON wallet replay card">' +
      '<div class="tools"><button class="primary lbcopy">COPY IMAGE</button>' +
      '<button class="lbdl">DOWNLOAD</button><button class="lbclose">CLOSE</button>' +
      '<span class="cap">the chart, every fill, and the rank</span></div></div></div>';
    stage.appendChild(ov);
    const q = c => ov.querySelector(c);
    const els = { rider:q('.rider'), glow:q('.glow'), burst:q('.burst'), flash:q('.flash'),
      whoN:q('.who b'), whoA:q('.who span'), tot:q('.tot'), clock:q('.clock'), combo:q('.combo'),
      warn:q('.warn'), load:q('.load'), loadSub:q('.load s'), gg:q('.gg'), rk:q('.gg .rk'),
      mx:q('.gg .mx'), sub:q('.gg .sub'), adr:q('.gg .adr') };

    // ---- audio ----
    let actx = null, muted = false;
    const ac = () => { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume(); return actx; };
    function tone(freq, t0, dur, type, peak, slideTo) {
      const c = ac(), o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    }
    const sBuy = u => { if (muted) return; const t = ac().currentTime, k = sz(u);
      tone(320 + 180*k, t, 0.10 + 0.06*k, 'sine', 0.05 + 0.09*k, 520 + 320*k); };
    const sSell = u => { if (muted) return; const t = ac().currentTime, k = sz(u);
      tone(1180, t, 0.055, 'square', 0.035 + 0.05*k); tone(1720, t + 0.055, 0.13 + 0.05*k, 'square', 0.03 + 0.05*k); };
    const sFan = () => { if (muted) return; const t = ac().currentTime;
      [523.25,659.25,783.99,1046.5].forEach((f,i) => tone(f, t + i*0.085, 0.22, 'triangle', 0.075)); };
    const sEnd = up => { if (muted) return; const t = ac().currentTime;
      (up ? [523.25,783.99,1046.5] : [440,349.23,261.63]).forEach((f,i) => tone(f, t + i*0.12, 0.34, 'triangle', 0.07)); };

    // ---- data ----
    async function walletTrades(w, maxPages = 25) {
      let cursor = null, out = [], pg = 0;
      while (pg < maxPages) {
        let u = `${JUP_TXS}/${CA}?limit=30&traderAddress=${w}`;
        if (cursor) u += `&offset=${cursor}`;
        const j = await (await fetch(u)).json();
        const txs = j.txs || [];
        if (!txs.length) break;
        out.push(...txs); pg++;
        els.loadSub.textContent = out.length + ' TRADES · ' + pg + ' PAGES';
        cursor = j.next; if (!cursor) break;
      }
      return { trades: out, capped: !!cursor };
    }

    // ---- particles ----
    let parts = [];
    function bcv() { const c = els.burst, w = stage.clientWidth, h = stage.clientHeight;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c; }
    function burst(x, y, n, color) {
      for (let i = 0; i < n; i++) {
        const a = (-Math.PI/2) + (Math.random()-.5)*2.1, sp = 1.6 + Math.random()*3.4;
        parts.push({ x, y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp, life: 1, c: color, r: 1.5 + Math.random()*2.4 });
      }
    }
    function drawParts() {
      const c = bcv(), g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      if (!parts.length) return;
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.13; p.life -= 0.019;
        if (p.life <= 0) continue;
        g.globalAlpha = Math.max(0, p.life); g.fillStyle = p.c; g.shadowBlur = 10; g.shadowColor = p.c;
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, 7); g.fill();
      }
      g.globalAlpha = 1; g.shadowBlur = 0;
      parts = parts.filter(p => p.life > 0);
    }
    function hitFx(green) {
      const f = els.flash; f.className = 'flash' + (green ? '' : ' red'); void f.offsetWidth;
      f.className = 'flash' + (green ? '' : ' red') + ' hit';
    }
    function combo(txt, color) {
      const c = els.combo; c.textContent = txt; c.style.color = color || '#4ade80';
      c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
    }

    // ---- rider ----
    let rf = 0, rlast = 0, rx = null, ry = null, jump = null, hurtT = 0, squashT = 0;
    const riderX = () => (rx == null ? null : rx);
    const riderY = () => (ry == null ? null : ry);
    let jumpCount = 0, maxArc = 0, hitCount = 0, arcPeaks = [], cutFlag = false, cutCount = 0;
    function rideTo(bar, nowT) {
      const r = els.rider, gl = els.glow;
      if (!bar) { r.className = 'rider'; gl.className = 'glow'; rx = ry = null; jump = null; return; }
      // ⚠ HIS X IS FIXED AT CENTRE. He used to track timeToCoordinate(newest candle), which
      // swept him across two thirds of the chart (measured 335..703 on a 740px stage) and
      // SNAPPED him hundreds of pixels sideways at every cut — and since cuts coincide with
      // fills, that read as a fresh character appearing on each buy. The camera already holds
      // the leading edge at centre, so the honest model is a runner: he stays put and the chart
      // scrolls under him. (timeToCoordinate also extrapolates outside the visible range —
      // measured x=6649 on a 1400px viewport — so tracking it was never safe anyway.)
      const W = stage.clientWidth || 0;
      const tx = W * 0.5;
      let ty = series.priceToCoordinate(bar.close);
      if (ty == null) { r.className = 'rider'; gl.className = 'glow'; return; }
      const now = nowT != null ? nowT : performance.now();
      let arc = 0, snapTo = false;
      if (jump) {
        const j = Math.max(0, Math.min(1, (now - jump.t0) / jump.dur));
        ty = jump.fromY + (jump.toY - jump.fromY) * j;
        arc = -Math.sin(Math.PI * j) * jump.h;
        if (-arc > maxArc) maxArc = -arc;
        snapTo = true;
        if (j >= 1) jump = null;
      }
      if (rx == null || cutFlag) { rx = tx; ry = ty; }
      const k = 0.16;
      rx = tx;                       // fixed — see above
      ry = snapTo ? ty : ry + (ty - ry) * k;
      let kx = 0, ky = 0;
      const hurt = now < hurtT;
      if (hurt) { const u = (hurtT - now) / 420; kx = -16*u; ky = -26*u*u; }
      let sq = 1;
      if (now < squashT) { const u = (squashT - now) / 180; sq = 1 - 0.22*Math.sin(Math.PI*u); }
      if (now - rlast > 90 && !jump) { rf = (rf + 1) % 6; rlast = now; }
      r.style.backgroundPosition = ((jump ? 2 : rf) * 20) + '% 0';
      // ⚠ He is anchored translate(-50%,-96%), so the sprite extends ~96% of its HEIGHT above
      // the anchor. A fill priced near the top of the view put his anchor at y=60, and with the
      // 46px arc on top his head sat at -57 — drawn outside the chart, which reads as "leaving
      // the screen and coming back". Clamp the RENDERED position, not the target, so the arc
      // still plays out; it just tops out against the ceiling.
      const H = stage.clientHeight || 0, RH = r.offsetHeight || 74, RW = r.offsetWidth || 74;
      const px = Math.max(RW * 0.5, Math.min(W - RW * 0.5, rx + kx));
      const py = Math.max(RH * 0.98, Math.min(H - 2, ry + arc + ky));
      r.style.left = px + 'px'; r.style.top = py + 'px';
      r.style.transform = 'translate(-50%,-96%) scaleY(' + sq.toFixed(3) + ')';
      r.className = 'rider on' + (hurt ? ' hurt' : '');
      gl.style.left = px + 'px'; gl.style.top = py + 'px';
      gl.className = 'glow on' + (hurt ? ' hurt' : '');
    }

    // ---- state ----
    let raf = null, runGen = 0, cur = null, tl = null, candles = [], viewLo = null, viewHi = null;
    let zoomBars = host.zoomBars || 155, lastN = host.lastN || 30, secPer = host.secPer || 5;

    series.applyOptions({ autoscaleInfoProvider: () =>
      (viewLo != null && viewHi != null && viewHi > viewLo) ? { priceRange: { minValue: viewLo, maxValue: viewHi } } : null });

    function markerFor(m, snap) {
      const t = snap(m.ts); if (t === null) return null;
      return { time: t, position: m.type === 'buy' ? 'belowBar' : 'aboveBar',
        color: m.type === 'buy' ? '#4ade80' : '#f87171', shape: 'circle',
        size: Math.max(0.55, Math.min(1.6, 0.5 + sz(m.usd) * 1.15)) };
    }

    function stop() {
      runGen++;
      if (raf) cancelAnimationFrame(raf);
      raf = null; viewLo = viewHi = null; parts = [];
      els.rider.className = 'rider'; els.glow.className = 'glow';
      els.clock.className = 'clock'; els.gg.className = 'gg'; ov.classList.remove('done');
      try { drawParts(); } catch (e) {}
    }

    function close() {
      stop();
      ov.classList.add('off');
      series.applyOptions({ autoscaleInfoProvider: () => null });
      onEnd();
    }

    // ---- COPY: the exact end-state view as a PNG on the clipboard ----
    // Same approach as index.html's chart screenshot button: the chart is a canvas, so a DOM
    // screenshot lib would miss it entirely. takeScreenshot() hands back the chart bitmap at
    // whatever pixel ratio it drew at, and the card is composited on top by hand at that same
    // ratio so nothing is resampled and the text stays crisp.
    // ⚠ The buttons are deliberately NOT drawn — they are UI, not part of the shareable image.
    function rr(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);         c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }
    const RANK_COL = { S:'#fbbf24', A:'#4ade80', B:'#38bdf8', C:'#c9ffdd', D:'#7d8b83', F:'#f87171', '?':'#7d8b83' };

    function snapshot() {
      if (!cur) return null;
      const p = cur.p, w = cur.w;
      const pic = chart.takeScreenshot();
      const W = stage.clientWidth || pic.width;
      const S = pic.width / W;
      const H = pic.height / S;
      const out = document.createElement('canvas');
      out.width = pic.width; out.height = pic.height;
      const c = out.getContext('2d');
      c.setTransform(S, 0, 0, S, 0, 0);
      c.drawImage(pic, 0, 0, W, H);

      const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
      const { mult, rank, label } = rankOf(p);

      // total pnl, top right — mirrors the live HUD
      c.textAlign = 'right'; c.textBaseline = 'alphabetic';
      c.font = '900 34px ' + MONO;
      c.fillStyle = p.total >= 0 ? '#4ade80' : '#f87171';
      c.shadowBlur = 26; c.shadowColor = c.fillStyle;
      c.fillText((p.total >= 0 ? '+' : '') + fmt(p.total), W - 14, 42);
      c.shadowBlur = 0;
      c.font = '700 8.5px ' + MONO; c.fillStyle = '#5a6862';
      c.fillText('TOTAL PNL', W - 14, 58);

      // ---- $ALON, top left. A screenshot that travels without the ticker on it advertises
      // nothing, so the brand leads and the rank card sits under it.
      if (PFP.complete && PFP.naturalWidth) {
        c.save(); rr(c, 14, 12, 42, 42, 11); c.clip();
        c.drawImage(PFP, 14, 12, 42, 42); c.restore();
        c.strokeStyle = 'rgba(74,222,128,.55)'; c.lineWidth = 1.5;
        rr(c, 14, 12, 42, 42, 11); c.stroke();
      }
      c.textAlign = 'left';
      c.fillStyle = '#4ade80'; c.font = '900 27px ' + MONO;
      c.shadowBlur = 20; c.shadowColor = 'rgba(74,222,128,.5)';
      c.fillText('$ALON', 64, 38);
      c.shadowBlur = 0;
      c.fillStyle = '#7d8b83'; c.font = '700 9px ' + MONO;
      c.fillText('W A L L E T   R E P L A Y', 65, 51);

      // the card, under the brand
      const cw = 250, ch = 150, cx = 14, cy = 68;
      c.fillStyle = 'rgba(11,14,15,0.92)';
      rr(c, cx, cy, cw, ch, 11); c.fill();
      c.strokeStyle = '#2e3637'; c.lineWidth = 1;
      rr(c, cx + .5, cy + .5, cw - 1, ch - 1, 11); c.stroke();

      c.textAlign = 'left';
      c.fillStyle = RANK_COL[rank] || '#e9f2ec';
      c.font = '900 52px ' + MONO;
      c.shadowBlur = 24; c.shadowColor = c.fillStyle;
      c.fillText(rank, cx + 15, cy + 58);
      c.shadowBlur = 0;
      // fit the label: letter-spaced first (it reads as a stamp), tight if that overflows,
      // then shrink. 'STOP TRADING START BELIEVING' is 28 chars and will not fit spaced.
      c.fillStyle = '#5a6862';
      const room = cw - 32;
      let lt = label.toUpperCase().split('').join(' '), fs = 8;
      c.font = '700 ' + fs + 'px ' + MONO;
      if (c.measureText(lt).width > room) {
        lt = label.toUpperCase();
        c.font = '700 ' + fs + 'px ' + MONO;
        while (c.measureText(lt).width > room && fs > 5.5) { fs -= 0.25; c.font = '700 ' + fs + 'px ' + MONO; }
      }
      c.fillText(lt, cx + 16, cy + 72);

      c.fillStyle = mult >= 1 ? '#4ade80' : '#f87171';
      c.font = '900 23px ' + MONO;
      c.fillText(mult.toFixed(2) + 'x', cx + 15, cy + 98);

      c.fillStyle = '#7d8b83'; c.font = '400 10.5px ' + MONO;
      c.fillText((p.total >= 0 ? '+' : '') + fmt(p.total) + ' on ' + fmt(p.bought) + ' in \u00b7 ' + p.trades + ' trades', cx + 15, cy + 116);
      c.fillStyle = '#5a6862'; c.font = '400 8.5px ' + MONO;
      c.fillText(short(w), cx + 15, cy + 130);

      // ---- watermark, centred over the chart ----
      // same treatment as index.html's copy-chart shot: sized off the card width so it reads the
      // same on a phone capture and a 4K one, and faint enough that it never hides a candle
      c.save();
      c.textAlign = 'center';
      const wm = Math.max(15, Math.min(30, W / 34));
      c.globalAlpha = 0.19;
      c.fillStyle = '#e9f2ec'; c.font = '800 ' + wm.toFixed(1) + 'px ' + MONO;
      c.fillText('CHARTED ON ALONPUMP.RUN', W / 2, H / 2 - wm * 0.25);
      c.globalAlpha = 0.16;
      c.font = '700 ' + (wm * 0.78).toFixed(1) + 'px ' + MONO;
      c.fillText('BY @THEJPEGJUNKIE', W / 2, H / 2 + wm * 0.95);
      c.restore();

      return out;
    }

    q('.gg .close').onclick = close;
    q('.gg .again').onclick = () => { els.gg.className = 'gg'; if (cur) run(cur.p, cur.capped, cur.w); };
    // COPY pops the graphic up to look at before you send it — the same shape as the
    // conviction share lightbox in index.html (copy image / download / post on X), so the two
    // shareable surfaces on the site behave identically.
    const lb = q('.lb'), lbImg = q('.lb img');
    let lastShot = null;

    q('.gg .copy').onclick = () => {
      const cv = snapshot();
      if (!cv) return;
      lastShot = cv;
      lbImg.src = cv.toDataURL('image/png');
      lb.className = 'lb on';
    };
    const closeLb = () => { lb.className = 'lb'; };
    q('.lb .lbclose').onclick = closeLb;
    lb.addEventListener('click', e => { if (e.target === lb) closeLb(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && lb.classList.contains('on')) closeLb(); });

    q('.lb .lbcopy').onclick = async () => {
      const btn = q('.lb .lbcopy');
      const done = t => { btn.textContent = t; setTimeout(() => { btn.textContent = 'COPY IMAGE'; }, 1600); };
      if (!lastShot) return;
      try {
        const blob = await new Promise(res => lastShot.toBlob(res, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        done('COPIED');
      } catch (e) {
        // image writes need a secure context and permission — say so rather than no-op
        done('USE DOWNLOAD');
      }
    };
    q('.lb .lbdl').onclick = () => {
      if (!lastShot) return;
      const a = document.createElement('a');
      a.download = 'alon-replay-' + (cur ? cur.w.slice(0, 6) : 'card') + '.png';
      a.href = lastShot.toDataURL('image/png');
      a.click();
    };


    return {
      el: ov,
      setMuted: m => { muted = m; },
      stop, close,
      isRunning: () => !!raf,
      async play(w) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) { onStatus('that does not look like a solana address'); return; }
        // ⚠ stop() bumps runGen, so it MUST happen before the generation is captured — capturing
        // first meant every guard below fired immediately and the replay aborted after fetching,
        // silently, with no error to show for it.
        stop();
        const my = ++runGen;
        ov.classList.remove('off');
        onBegin();
        els.load.className = 'load on'; els.loadSub.textContent = '';
        onStatus('fetching trades…');
        const { trades, capped } = await walletTrades(w);
        if (my !== runGen) return;
        if (!trades.length) { els.load.className = 'load'; onStatus('no $ALON trades for that wallet'); return; }
        const p = window.computePnl(trades, getPrice());
        els.loadSub.textContent = 'LOADING CHART HISTORY';
        candles = await host.ensureCandles(p.firstTs);
        if (my !== runGen) return;
        els.load.className = 'load';
        cur = { p, capped, w };
        tl = null;
        run(p, capped, w);
      },
    };

    function buildTimeline(p) {
      const src = p.marks.map(m => ({ type: m.type, amount: m.amount, usdVolume: m.usd, usdPrice: m.px,
        timestamp: new Date(m.ts).toISOString(), txHash: m.hash }));
      const out = [];
      for (let i = 1; i <= src.length; i++) out.push({ ts: p.marks[i-1].ts, mark: p.marks[i-1], state: window.computePnl(src.slice(0, i), getPrice()) });
      return out;
    }

    function run(p, capped, w) {
      if (!candles.length || !p.marks.length) return;
      const supply = getSupply();
      if (!tl) tl = buildTimeline(p);

      els.whoN.textContent = (host.nameFor && host.nameFor(w)) || short(w);
      els.whoA.textContent = w;
      els.warn.className = 'warn' + (p.flags.partial || capped ? ' on' : '');
      els.warn.textContent = p.flags.partial
        ? `⚠ PARTIAL HISTORY — ${Math.round(p.flags.phantomTokens).toLocaleString()} tokens sold that Jupiter never saw acquired. The total is a FLOOR, not the answer.`
        : (capped ? '⚠ TRUNCATED — newest 750 trades only; older buys missing, so pnl reads high.' : '');

      const BUCKET = 3600;
      const snap = ms => { const t = Math.floor(ms/1000/BUCKET)*BUCKET;
        if (!candles.length) return t;
        if (t < candles[0].time) return null;
        return Math.min(t, candles[candles.length-1].time); };

      function headAt(t) {
        let lo = 0, hi = candles.length - 1;
        if (t <= candles[0].time*1000) return 0;
        if (t >= candles[hi].time*1000) return hi;
        while (lo < hi - 1) { const m = (lo+hi)>>1; (candles[m].time*1000 <= t) ? lo = m : hi = m; }
        const a = candles[lo].time*1000, b = candles[hi].time*1000;
        return lo + (b > a ? (t - a)/(b - a) : 0);
      }

      const N = lastN === 'all' ? tl.length : Math.min(lastN, tl.length);
      const s0 = tl.length - N;
      const seed = s0 > 0 ? tl[s0-1].state : null;
      const knots = [tl[s0].ts - (tl[tl.length-1].ts - tl[s0].ts || 36e5)*0.06, ...tl.slice(s0).map(e => e.ts)];
      const hK = knots.map(headAt);
      const GAP_MAX = zoomBars*0.35, JUMP_MS = 520;
      const travel = [], cum = [0];
      for (let i = 0; i < N; i++) { const t = Math.max(0.5, Math.min(hK[i+1]-hK[i], GAP_MAX)); travel.push(t); cum.push(cum[i]+t); }
      const total = cum[N];
      const RATE = zoomBars/7.5;
      const DUR = Math.max(6000, Math.min(70000, total/RATE*1000*(secPer/5)));

      series.setData([]); series.setMarkers([]);
      viewLo = viewHi = null; parts = []; ov.classList.remove('done');
      jump = null; hurtT = 0; squashT = 0; jumpCount = 0; maxArc = 0; hitCount = 0; arcPeaks = []; cutFlag = false; cutCount = 0;
      rx = ry = null;

      let ci = 0, ti = s0, best = -Infinity, lastFan = 0, streak = 0, prevReal = seed ? seed.realized : 0;
      let headF = 0, prevSi = -1;
      const shown = [];
      for (let k = 0; k < s0; k++) { const mk = markerFor(tl[k].mark, snap);
        if (mk) { mk.color = tl[k].mark.type === 'buy' ? '#1f6f42' : '#7a3838'; shown.push(mk); } }
      while (ci < candles.length && candles[ci].time*1000 <= knots[0]) { series.update(candles[ci]); ci++; }
      if (shown.length) series.setMarkers(shown.slice().sort((a,b) => a.time - b.time));
      if (seed) { setTot(seed); best = seed.total; }

      const myRun = ++runGen;
      const start = performance.now();
      els.clock.className = 'clock on';
      ac();

      function setTot(st) {
        els.tot.textContent = (st.total >= 0 ? '+' : '') + fmt(st.total);
        els.tot.className = 'tot ' + (st.total >= 0 ? 'up' : 'down');
        if (host.onStats) host.onStats(st);
      }

      function frame(now) {
        if (myRun !== runGen) return;
        const prog = Math.min(1, (now - start)/DUR);
        const pos = prog*total;
        let si = 0; while (si < N-1 && cum[si+1] <= pos) si++;
        const into = pos - cum[si];
        const prevHead = headF;
        headF = hK[si+1] - travel[si] + into;
        cutFlag = (si !== prevSi) && Math.abs(headF - prevHead) > 3;
        prevSi = si;
        if (cutFlag) { cutCount++; jump = null; }

        while (ci < candles.length && ci <= Math.floor(headF)) { series.update(candles[ci]); ci++; }

        const msLeft = total > 0 ? ((cum[si+1] - pos)/total)*DUR : 0;
        if (!jump && msLeft <= JUMP_MS && ti < tl.length && rx != null && ry != null) {
          const m = tl[ti].mark, ty2 = series.priceToCoordinate(m.px*supply);
          if (ty2 != null) { jumpCount++; arcPeaks.push(m.type === 'buy' ? 46 : 20);
            jump = { t0: now, dur: Math.max(120, msLeft), fromY: ry, toY: ty2, h: m.type === 'buy' ? 46 : 20 }; }
        }

        let fired = false;
        while (ti < tl.length && ti - s0 < N && pos >= cum[ti-s0+1] - 1e-9) {
          const e = tl[ti];
          const mk = markerFor(e.mark, snap); if (mk) shown.push(mk);
          e.mark.type === 'buy' ? sBuy(e.mark.usd) : sSell(e.mark.usd);
          jump = null;
          if (e.mark.type === 'buy') squashT = now + 180;
          else { hurtT = now + 420; hitCount++; hitFx(false); }
          setTot(e.state);
          const bx = chart.timeScale().timeToCoordinate(snap(e.mark.ts)), by = series.priceToCoordinate(e.mark.px*supply);
          if (bx != null && by != null) {
            if (e.mark.type === 'sell' && e.state.realized > prevReal - 1e-9) burst(bx, by, Math.round(6 + 18*sz(e.mark.usd)), '#fbbf24');
            else burst(bx, by, Math.round(3 + 8*sz(e.mark.usd)), e.mark.type === 'buy' ? '#4ade80' : '#f87171');
          }
          if (e.mark.type === 'sell') { const d = e.state.realized - prevReal;
            if (d > 0) { streak++; if (streak > 1) combo('x' + streak + ' STREAK'); }
            else if (d < 0) { if (streak > 2) combo('STREAK LOST', '#f87171'); streak = 0; }
            prevReal = e.state.realized; }
          if (e.state.total > best && e.state.total > 0 && best > -Infinity && e.state.total > best*1.25 && now - lastFan > 1100) {
            sFan(); lastFan = now; hitFx(true); combo(fmt(e.state.total) + ' NEW HIGH', '#fbbf24');
            if (bx != null && by != null) burst(bx, by, 34, '#fbbf24');
          }
          if (e.state.total > best) best = e.state.total;
          ti++; fired = true;
        }
        if (fired) series.setMarkers(shown.slice().sort((a,b) => a.time - b.time));

        if (ci > 0) {
          const head = Math.max(0, headF - 1), half = zoomBars/2;
          try { chart.timeScale().setVisibleLogicalRange({ from: head - half, to: head + half }); } catch (e) {}
          let mn = Infinity, mx = -Infinity;
          const hi2 = Math.min(ci-1, Math.floor(head));
          for (let k = Math.max(0, Math.floor(head - half)); k <= hi2; k++) {
            if (candles[k].low < mn) mn = candles[k].low;
            if (candles[k].high > mx) mx = candles[k].high;
          }
          if (mn < Infinity && mx > -Infinity) {
            const pad = (mx-mn)*0.30 || Math.abs(mx)*0.05 || 1;
            const tLo = mn - pad, tHi = mx + pad;
            if (viewLo == null) { viewLo = tLo; viewHi = tHi; }
            else { const kk = 0.028;
              viewLo = Math.min(tLo, viewLo + (tLo-viewLo)*kk);
              viewHi = Math.max(tHi, viewHi + (tHi-viewHi)*kk); }
          }
        }

        rideTo(candles[Math.max(0, Math.min(candles.length-1, ci-1))], now);
        drawParts();
        els.clock.textContent = mmss(now - start);
        onStatus('▶ ' + (ti - s0) + '/' + N + ' trades' + (s0 > 0 ? ` (last ${N} of ${tl.length})` : ''));

        if (prog < 1) { raf = requestAnimationFrame(frame); return; }

        viewLo = viewHi = null;
        series.setData(candles);
        series.setMarkers(p.marks.map(m => markerFor(m, snap)).filter(Boolean).sort((a,b) => a.time - b.time));
        setTot(p);
        chart.timeScale().fitContent();
        els.rider.className = 'rider'; els.glow.className = 'glow'; parts = []; drawParts();
        sEnd(p.total >= 0); hitFx(p.total >= 0);
        raf = null; els.clock.className = 'clock';
        onStatus(`${p.trades} trades · replay complete` + (s0 > 0 ? ` · animated the last ${N}` : ''));
        setTimeout(() => {
          ov.classList.add('done');
          hitFx(p.total >= 0);            // one bang across the chart, not a permanent veil
          const { mult, rank, label } = rankOf(p);
          els.rk.innerHTML = rank + '<small style="letter-spacing:' +
            (label.length > 14 ? '.12em' : '.3em') + '">' + label + '</small>';
          els.rk.className = 'rk r' + rcls(rank);
          els.mx.textContent = mult.toFixed(2) + 'x';
          els.mx.style.color = mult >= 1 ? '#4ade80' : '#f87171';
          els.sub.textContent = (p.total >= 0 ? '+' : '') + fmt(p.total) + ' on ' + fmt(p.bought) + ' in · ' + p.trades + ' trades';
          els.adr.textContent = short(w);
          els.gg.className = 'gg on';
          if (rank === 'S' || rank === 'A') sFan();
        }, 420);
      }
      raf = requestAnimationFrame(frame);
      window.__rpBeats = () => ({ jumps: jumpCount, maxArc, hits: hitCount, cuts: cutCount,
        distinctPeaks: [...new Set(arcPeaks)].length });
    }
  };
})();
