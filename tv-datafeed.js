// ===== ALON datafeed for TradingView Advanced Charts =====
// Implements TradingView's JS Datafeed API on top of Jupiter's candle endpoint.
// Drop the charting_library/ folder next to this file, then in index.html:
//
//   <script src="charting_library/charting_library.standalone.js"></script>
//   <script src="tv-datafeed.js"></script>
//   new TradingView.widget({
//       container: 'chart', library_path: 'charting_library/',
//       symbol: 'ALON/SOL', interval: '60', theme: 'dark', autosize: true,
//       datafeed: AlonDatafeed(supply),          // supply = tokens, so bars read in market cap
//       disabled_features: ['header_symbol_search', 'symbol_search_hot_key'],
//       enabled_features: ['hide_left_toolbar_by_default'],
//   });
//
// ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE:
// Jupiter's COARSE intervals (4_HOUR, 1_DAY, 1_WEEK, 1_MONTH) are downsampled, not true OHLC —
// they clip wicks. ALON's jan-2025 top reads $37M on 1_DAY, $79M on 4_HOUR and $250M on 1_HOUR,
// all for the same candle. Coarser intervals reporting LOWER highs is impossible for real
// aggregation. So nothing coarser than 1_HOUR is ever requested; 4H/1D/1W are rolled up here.

(function (global) {
    'use strict';

    const CA = '8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS';
    const CHART = 'https://datapi.jup.ag/v2/charts';
    const PAGE = 1500;

    // TradingView resolution -> how we source it.
    // `iv` is fetched directly; `roll` means fetch 1_HOUR and aggregate into buckets of N seconds.
    const RES = {
        '1':   { iv: '1_MINUTE',  sec: 60 },
        '5':   { iv: '5_MINUTE',  sec: 300 },
        '15':  { iv: '15_MINUTE', sec: 900 },
        '30':  { iv: '30_MINUTE', sec: 1800 },
        '60':  { iv: '1_HOUR',    sec: 3600 },
        '240': { iv: '1_HOUR',    sec: 3600, roll: 4 * 3600 },
        '1D':  { iv: '1_HOUR',    sec: 3600, roll: 24 * 3600 },
        '1W':  { iv: '1_HOUR',    sec: 3600, roll: 7 * 24 * 3600 },
    };

    const cache = {};      // interval -> { rows: [], done: bool }
    let lastFetch = 0;

    async function fetchPage(interval, to) {
        const gap = Date.now() - lastFetch;
        if (gap < 250) await new Promise(r => setTimeout(r, 250 - gap));
        const url = `${CHART}/${CA}?interval=${interval}&to=${encodeURIComponent(to.toISOString())}&candles=${PAGE}`;

        for (let att = 1; att <= 3; att++) {
            lastFetch = Date.now();
            const res = await fetch(url);
            if (res.status === 429) { await new Promise(r => setTimeout(r, att * 3000)); continue; }
            if (!res.ok) throw new Error('jupiter ' + res.status);
            const j = await res.json();
            // key by time — jupiter can repeat a timestamp, and duplicate bars break charting libs
            const byTime = new Map();
            for (const c of (j.candles || [])) {
                if (c.open == null || c.high == null || c.low == null || c.close == null) continue;
                byTime.set(c.time, c);
            }
            return [...byTime.values()].sort((a, b) => a.time - b.time);
        }
        throw new Error('rate limited');
    }

    function merge(a, b) {
        const m = new Map();
        for (const x of a) m.set(x.time, x);
        for (const x of b) m.set(x.time, x);
        return [...m.values()].sort((p, q) => p.time - q.time);
    }

    // real OHLC rollup: high is the max across the bucket, not a sampled point
    function rollup(rows, sec) {
        const out = new Map();
        for (const c of rows) {
            const k = Math.floor(c.time / sec) * sec;
            const b = out.get(k);
            if (!b) out.set(k, { time: k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
            else {
                if (c.high > b.high) b.high = c.high;
                if (c.low < b.low) b.low = c.low;
                b.close = c.close;
                b.volume += c.volume || 0;
            }
        }
        return [...out.values()].sort((a, b) => a.time - b.time);
    }

    // grow the cached series backwards until it reaches `fromSec` (or history runs out)
    async function ensureBack(interval, fromSec) {
        const store = cache[interval] = cache[interval] || { rows: [], done: false };
        if (!store.rows.length) store.rows = await fetchPage(interval, new Date());
        let guard = 0;
        while (!store.done && store.rows.length && store.rows[0].time > fromSec && guard++ < 20) {
            const oldest = store.rows[0].time;
            const page = await fetchPage(interval, new Date(oldest * 1000));
            if (!page.some(c => c.time < oldest)) { store.done = true; break; }
            store.rows = merge(store.rows, page);
        }
        return store;
    }

    global.AlonDatafeed = function (supplyGetter) {
        // pass a number, or a function returning it, so bars can be expressed in market cap
        const mult = () => {
            const s = typeof supplyGetter === 'function' ? supplyGetter() : supplyGetter;
            return s && s > 0 ? s : 1;
        };

        const subs = {};   // subscriberUID -> interval handle

        return {
            onReady(cb) {
                setTimeout(() => cb({
                    supported_resolutions: Object.keys(RES),
                    supports_marks: false,
                    supports_timescale_marks: false,
                    supports_time: true,
                    exchanges: [{ value: 'raydium', name: 'Raydium', desc: 'Raydium (Solana)' }],
                    symbols_types: [{ name: 'crypto', value: 'crypto' }],
                }), 0);
            },

            searchSymbols(userInput, exchange, symbolType, onResult) {
                onResult([{
                    symbol: 'ALON/SOL', full_name: 'RAYDIUM:ALON/SOL', description: 'alon — market cap',
                    exchange: 'Raydium', ticker: 'ALON/SOL', type: 'crypto',
                }]);
            },

            resolveSymbol(symbolName, onResolve, onError) {
                setTimeout(() => onResolve({
                    name: 'ALON/SOL',
                    ticker: 'ALON/SOL',
                    description: 'alon — market cap (USD)',
                    type: 'crypto',
                    session: '24x7',
                    timezone: 'Etc/UTC',
                    exchange: 'Raydium',
                    listed_exchange: 'Raydium',
                    format: 'price',
                    minmov: 1,
                    pricescale: 100,              // market cap in whole dollars, 2dp
                    has_intraday: true,
                    has_daily: true,
                    has_weekly_and_monthly: true,
                    intraday_multipliers: ['1', '5', '15', '30', '60', '240'],
                    supported_resolutions: Object.keys(RES),
                    volume_precision: 0,
                    data_status: 'streaming',
                }), 0);
            },

            async getBars(symbolInfo, resolution, periodParams, onResult, onError) {
                const cfg = RES[resolution] || RES['60'];
                const { from, to, firstDataRequest } = periodParams;
                try {
                    const store = await ensureBack(cfg.iv, from);
                    const rows = cfg.roll ? rollup(store.rows, cfg.roll) : store.rows;
                    const m = mult();
                    const bars = rows
                        .filter(c => c.time >= from && c.time < to)
                        .map(c => ({
                            time: c.time * 1000,          // TradingView wants ms
                            open: c.open * m, high: c.high * m, low: c.low * m, close: c.close * m,
                            volume: c.volume || 0,
                        }));
                    onResult(bars, { noData: bars.length === 0 && store.done });
                } catch (e) {
                    onError(e.message);
                }
            },

            subscribeBars(symbolInfo, resolution, onTick, uid) {
                const cfg = RES[resolution] || RES['60'];
                subs[uid] = setInterval(async () => {
                    if (document.hidden) return;
                    try {
                        const page = await fetchPage(cfg.iv, new Date());
                        const store = cache[cfg.iv] = cache[cfg.iv] || { rows: [], done: false };
                        store.rows = merge(store.rows, page);
                        const rows = cfg.roll ? rollup(store.rows, cfg.roll) : store.rows;
                        const last = rows[rows.length - 1];
                        if (!last) return;
                        const m = mult();
                        onTick({
                            time: last.time * 1000,
                            open: last.open * m, high: last.high * m, low: last.low * m, close: last.close * m,
                            volume: last.volume || 0,
                        });
                    } catch (e) { /* next tick */ }
                }, 15000);
            },

            unsubscribeBars(uid) {
                clearInterval(subs[uid]);
                delete subs[uid];
            },
        };
    };
})(window);
