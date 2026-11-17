/*
 * PoolMath — Shared BitShares AMM Liquidity Pool Math & Valuation Module
 *
 * Implements chain-exact constant-product AMM swap formulas, maker and taker
 * market fees, slippage limits, price impact, and canonical LP share valuations
 * (USD pool reference and Day-One constituent deconstruction).
 *
 * Standard BitShares Reference:
 *   - libraries/chain/liquidity_pool_evaluator.cpp (liquidity_pool_exchange_evaluator)
 *   - database::calculate_market_fee (flags 0x01, maker & taker extensions, max_market_fee)
 *
 * Browser: exposes window.PoolMath. Node: module.exports.
 */
(function (root, factory) {
    const lib = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = lib;
    } else {
        root.PoolMath = lib;
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const PERCENT_100 = 10000n; // 100.00% = 10000 basis points
    const DEFAULT_SLIPPAGE_PERMILLE = 10n; // 1.0%

    const USD_ASSETS = ["XBTSX.USDT", "XBTSX.USDC", "HONEST.USD", "GDEX.USDT", "DEFI.USDT"];
    const BTC_ASSETS = ["XBTSX.BTC", "BTWTY.BTC", "GDEX.BTC"];

    // ---------- integer utilities ----------
    function big(v) {
        if (typeof v === "bigint") return v;
        if (typeof v === "number") return BigInt(Math.trunc(v));
        if (typeof v === "string" && v.length) return BigInt(v.split(".")[0]);
        return 0n;
    }

    function ceilDiv(a, b) {
        a = big(a);
        b = big(b);
        if (b === 0n) return 0n;
        return (a + b - 1n) / b;
    }

    function bigMin(a, b) {
        a = big(a);
        b = big(b);
        return a < b ? a : b;
    }

    function bigMax(a, b) {
        a = big(a);
        b = big(b);
        return a > b ? a : b;
    }

    // ---------- pool reserve helpers ----------
    function poolHas(pool, assetId) {
        return !!pool && (pool.asset_a === assetId || pool.asset_b === assetId);
    }

    function otherAsset(pool, assetId) {
        if (!pool) return null;
        return pool.asset_a === assetId ? pool.asset_b : pool.asset_a;
    }

    function reserves(pool, assetInId) {
        if (!pool) return [0n, 0n];
        const isA = pool.asset_a === assetInId;
        return [big(isA ? pool.balance_a : pool.balance_b), big(isA ? pool.balance_b : pool.balance_a)];
    }

    // ---------- market fee calculation ----------
    /**
     * BitShares calculate_market_fee:
     * Maker side pays market_fee_percent.
     * Taker side pays extensions.taker_fee_percent when present, else market_fee_percent.
     * Capped at max_market_fee when defined.
     * Only applies if asset has flag charge_market_fee (0x01).
     */
    function marketFee(assetObj, amount, isMaker = true) {
        amount = big(amount);
        if (!assetObj || !assetObj.options || amount <= 0n) return 0n;
        const o = assetObj.options;
        if ((Number(o.flags) & 0x01) === 0) return 0n; // charge_market_fee not set
        const ext = o.extensions || {};
        const pct = big(!isMaker && ext.taker_fee_percent !== undefined && ext.taker_fee_percent !== null
            ? ext.taker_fee_percent
            : (o.market_fee_percent || 0));
        if (pct <= 0n) return 0n;
        const fee = (amount * pct) / PERCENT_100;
        const max = o.max_market_fee !== undefined && o.max_market_fee !== null ? big(o.max_market_fee) : null;
        return max !== null && max >= 0n ? bigMin(fee, max) : fee;
    }

    // ---------- constant product swap calculation ----------
    /**
     * Chain-exact quote for selling `amountIn` of `assetInId` into `pool`.
     *
     * Exact chain order of operations (liquidity_pool_exchange_evaluator):
     *   1. Deduct maker market fee from input amount: pool receives input - makerMarketFee.
     *   2. Constant-product output: delta = balOut - ceilDiv(balIn * balOut, balIn + poolReceives).
     *   3. Deduct pool taker fee: delta * taker_fee_percent / 10000. Pool pays delta - poolTakerFee.
     *   4. Deduct taker market fee from bought asset: pays - takerMarketFee.
     *   5. Apply slippage limit to expected output.
     *
     * @param {Object} pool - Chain pool object (asset_a, asset_b, balance_a, balance_b, taker_fee_percent)
     * @param {BigInt|number|string} amountIn - Satoshis to sell
     * @param {string} assetInId - Asset ID being sold (e.g. '1.3.0')
     * @param {BigInt|number} [slippagePermille=10] - Slippage tolerance in permille (10 = 1.0%)
     * @param {Object} [assets={}] - Map of asset objects by ID for market fees
     * @returns {Object} Swap quote details (all amounts as BigInt satoshis)
     */
    function calculatePoolSwap(pool, amountIn, assetInId, slippagePermille = DEFAULT_SLIPPAGE_PERMILLE, assets = {}) {
        const zero = {
            expectedOut: 0n,
            minReceive: 0n,
            makerMarketFee: 0n,
            poolTakerFee: 0n,
            takerMarketFee: 0n,
            takerFeeBps: 0,
            priceImpactBps: 0,
            delta: 0n,
            poolReceives: 0n
        };
        amountIn = big(amountIn);
        slippagePermille = big(slippagePermille);

        if (!poolHas(pool, assetInId) || amountIn <= 0n) return zero;
        const [balIn, balOut] = reserves(pool, assetInId);
        if (balIn <= 0n || balOut <= 0n) return zero;
        const outId = otherAsset(pool, assetInId);

        const inAssetObj = assets[assetInId];
        const outAssetObj = assets[outId];

        const makerMarketFee = marketFee(inAssetObj, amountIn, true);
        const poolReceives = amountIn - makerMarketFee;
        if (poolReceives <= 0n) return zero;

        const delta = balOut - ceilDiv(balIn * balOut, balIn + poolReceives);
        if (delta <= 0n) return zero;

        const takerFee = big(pool.taker_fee_percent || 0);
        const poolTakerFee = (delta * takerFee) / PERCENT_100;
        const poolPays = delta - poolTakerFee;
        if (poolPays <= 0n) return zero;

        const takerMarketFee = marketFee(outAssetObj, poolPays, false);
        const expectedOut = poolPays > takerMarketFee ? poolPays - takerMarketFee : 0n;

        const slipFactor = 1000n > slippagePermille ? 1000n - slippagePermille : 0n;
        const minReceive = (expectedOut * slipFactor) / 1000n;

        // Spot output before trade: (poolReceives * balOut) / balIn
        const spotOut = (poolReceives * balOut) / balIn;
        const priceImpactBps = spotOut > 0n && spotOut > delta
            ? Number(((spotOut - delta) * 10000n) / spotOut)
            : 0;

        return {
            expectedOut,
            minReceive,
            makerMarketFee,
            poolTakerFee,
            takerMarketFee,
            takerFeeBps: Number(takerFee),
            priceImpactBps,
            delta,
            poolReceives
        };
    }

    // ---------- deposit pairing ----------
    /**
     * Paired amount of the other asset needed for balanced pool deposit.
     */
    function pairedAmount(pool, amount, assetId, roundUp = false) {
        amount = big(amount);
        const [bal, other] = reserves(pool, assetId);
        if (bal <= 0n) return 0n;
        return roundUp ? ceilDiv(amount * other, bal) : (amount * other) / bal;
    }

    // ---------- pool state after a swap ----------
    /**
     * Pool reserves after the swap `quote` (from calculatePoolSwap) executes.
     * Chain order (liquidity_pool_exchange_evaluator::do_apply): the sold side grows by
     * what the pool receives (input minus maker market fee); the bought side shrinks by
     * what the pool pays (delta minus the pool taker fee, which stays in the pool).
     * Returns a shallow copy of `pool` with balance_a / balance_b as strings.
     */
    function poolAfterSwap(pool, assetInId, quote) {
        if (!poolHas(pool, assetInId) || !quote || big(quote.delta) <= 0n) return Object.assign({}, pool);
        const receives = big(quote.poolReceives);
        const pays = big(quote.delta) - big(quote.poolTakerFee);
        const isA = pool.asset_a === assetInId;
        let balA = big(pool.balance_a);
        let balB = big(pool.balance_b);
        if (isA) { balA += receives; balB -= pays; } else { balB += receives; balA -= pays; }
        return Object.assign({}, pool, { balance_a: String(balA), balance_b: String(balB) });
    }

    // ---------- deposit share minting ----------
    /**
     * Chain-exact liquidity_pool_deposit (op 61) into a pool that already has liquidity
     * (liquidity_pool_deposit_evaluator):
     *   sharesA = supply * amountA / balA   (round down)
     *   sharesB = supply * amountB / balB   (round down)
     *   shares  = min(sharesA, sharesB, maxSupply - supply)
     * The limiting side is taken in full; the other side takes
     * ceil(shares * bal / supply). Anything left over stays with the depositor (dust).
     *
     * @param {Object} pool - Pool object (balance_a, balance_b) as it is when the deposit runs
     * @param {BigInt|number|string} amountA - Satoshis of asset_a offered
     * @param {BigInt|number|string} amountB - Satoshis of asset_b offered
     * @param {BigInt|number|string} shareSupply - Share asset current_supply (satoshis)
     * @param {BigInt|number|string} [maxSupply] - Share asset options.max_supply (satoshis)
     * @returns {Object} { shares, takeA, takeB, dustA, dustB, limitedBy } (BigInt satoshis)
     */
    function estimateDeposit(pool, amountA, amountB, shareSupply, maxSupply) {
        amountA = big(amountA);
        amountB = big(amountB);
        const supply = big(shareSupply);
        const balA = big(pool && pool.balance_a);
        const balB = big(pool && pool.balance_b);
        const none = { shares: 0n, takeA: 0n, takeB: 0n, dustA: amountA, dustB: amountB, limitedBy: null };
        if (amountA <= 0n || amountB <= 0n || supply <= 0n || balA <= 0n || balB <= 0n) return none;

        const sharesA = (supply * amountA) / balA;
        const sharesB = (supply * amountB) / balB;
        let shares = bigMin(sharesA, sharesB);
        if (maxSupply !== undefined && maxSupply !== null) {
            const room = big(maxSupply) - supply;
            shares = bigMin(shares, room > 0n ? room : 0n);
        }
        if (shares <= 0n) return none;

        const takeA = shares === sharesA ? amountA : ceilDiv(shares * balA, supply);
        const takeB = shares === sharesB ? amountB : ceilDiv(shares * balB, supply);
        return {
            shares,
            takeA,
            takeB,
            dustA: amountA - takeA,
            dustB: amountB - takeB,
            limitedBy: sharesA <= sharesB ? "a" : "b"
        };
    }

    // ---------- single-asset zap (swap part, deposit all) ----------
    /**
     * Estimates the LP shares a single-asset amount turns into by selling `splitBps`
     * (default 50%) of it into the pool for the other asset, then depositing both legs.
     * The deposit is priced against the pool as it is after the swap.
     *
     * @param {Object} pool - Chain pool object
     * @param {BigInt|number|string} amountIn - Satoshis of `assetInId` to zap
     * @param {string} assetInId - Asset being zapped (must be in the pool)
     * @param {BigInt|number|string} shareSupply - Share asset current_supply (satoshis)
     * @param {Object} [opts] - { slippagePermille, assets, splitBps, maxSupply }
     * @returns {Object|null} { swapIn, keep, swap, poolAfter, deposit, depositAtMin, amountA, amountB, inIsA }
     */
    function estimateZap(pool, amountIn, assetInId, shareSupply, opts = {}) {
        amountIn = big(amountIn);
        if (!poolHas(pool, assetInId) || amountIn <= 0n) return null;
        const splitBps = big(opts.splitBps !== undefined ? opts.splitBps : 5000);
        const slip = opts.slippagePermille !== undefined ? opts.slippagePermille : DEFAULT_SLIPPAGE_PERMILLE;
        const assets = opts.assets || {};

        const swapIn = (amountIn * splitBps) / PERCENT_100;
        const keep = amountIn - swapIn;
        const swap = calculatePoolSwap(pool, swapIn, assetInId, slip, assets);
        const poolAfter = poolAfterSwap(pool, assetInId, swap);
        const inIsA = pool.asset_a === assetInId;

        const pair = out => inIsA ? [keep, out] : [out, keep];
        const [amountA, amountB] = pair(swap.expectedOut);
        const deposit = estimateDeposit(poolAfter, amountA, amountB, shareSupply, opts.maxSupply);
        const [minA, minB] = pair(swap.minReceive);
        const depositAtMin = estimateDeposit(poolAfter, minA, minB, shareSupply, opts.maxSupply);

        return { swapIn, keep, swap, poolAfter, deposit, depositAtMin, amountA, amountB, inIsA };
    }

    // ---------- order book walk ----------
    /**
     * Taker quote for selling `amountIn` of `assetInId` into the open order book, best price first.
     * `orders` are get_limit_orders rows; only those selling `assetOutId` for `assetInId` are used.
     * A maker order filled in full pays its for_sale and costs ceil(for_sale * quote / base); the
     * last, partial fill gets floor(rest * base / quote). The taker market fee on the received
     * asset is charged per fill, as the chain does. Integer exact to within a satoshi per fill.
     *
     * @returns {Object} { spent, unfilled, grossOut, takerMarketFee, expectedOut, fills, worst }
     *   (BigInt satoshis; worst is the last order touched, { base, quote } of its sell_price)
     */
    // Sorted levels per orders array and direction. Searches (inputForOutput, splitSwap) walk the
    // same book thousands of times; callers pass a fresh array when the book changes and never
    // mutate one in place.
    const bookLevelCache = new WeakMap();
    function bookLevels(orders, assetInId, assetOutId) {
        if (!orders) return [];
        let byPair = bookLevelCache.get(orders);
        if (!byPair) bookLevelCache.set(orders, byPair = new Map());
        const key = assetInId + ">" + assetOutId;
        let levels = byPair.get(key);
        if (!levels) {
            levels = orders
                .filter(o => o && o.sell_price && o.sell_price.base.asset_id === assetOutId && o.sell_price.quote.asset_id === assetInId)
                .map(o => ({ forSale: big(o.for_sale), base: big(o.sell_price.base.amount), quote: big(o.sell_price.quote.amount) }))
                .filter(l => l.forSale > 0n && l.base > 0n && l.quote > 0n)
                // Best first: most out per unit in, i.e. highest base / quote
                .sort((a, b) => { const d = b.base * a.quote - a.base * b.quote; return d < 0n ? -1 : d > 0n ? 1 : 0; });
            byPair.set(key, levels);
        }
        return levels;
    }

    function walkOrderBook(orders, amountIn, assetInId, assetOutId, assets = {}) {
        amountIn = big(amountIn);
        const levels = bookLevels(orders, assetInId, assetOutId);

        const outAssetObj = assets[assetOutId];
        let rest = amountIn > 0n ? amountIn : 0n;
        let grossOut = 0n, takerMarketFee = 0n, fills = 0, worst = null;
        for (const l of levels) {
            if (rest <= 0n) break;
            const cost = ceilDiv(l.forSale * l.quote, l.base);
            const pay = rest >= cost ? cost : rest;
            const get = rest >= cost ? l.forSale : (rest * l.base) / l.quote;
            if (get <= 0n) break;
            rest -= pay;
            grossOut += get;
            takerMarketFee += marketFee(outAssetObj, get, false);
            fills++;
            worst = { base: l.base, quote: l.quote };
        }
        return {
            spent: amountIn - rest,
            unfilled: rest,
            grossOut,
            takerMarketFee,
            expectedOut: grossOut - takerMarketFee,
            fills,
            worst
        };
    }

    /**
     * Smallest input whose quote reaches `target` output, for any quote function that never
     * pays less for more (calculatePoolSwap, walkOrderBook). quoteOut(amountIn) returns BigInt
     * output. Returns null when no input reaches the target (not enough liquidity).
     */
    function inputForOutput(quoteOut, target) {
        target = big(target);
        if (target <= 0n) return null;
        let lo = 0n, hi = 1n;
        while (quoteOut(hi) < target) {
            lo = hi;
            hi *= 2n;
            if (hi > (1n << 96n)) return null;
        }
        while (hi - lo > 1n) {
            const mid = (lo + hi) / 2n;
            if (quoteOut(mid) >= target) hi = mid; else lo = mid;
        }
        return hi;
    }

    /**
     * Best split of one trade of `amount` between two venues A and B (e.g. order book and pool).
     *
     * valueA(x) / valueB(x) give what venue A / B yields for x of the amount: output received
     * (sell, exact input: maximise the sum) or input paid (buy, exact output: pass
     * { minimise: true }). Either may return null when the venue cannot take x (not enough
     * depth); neither is called with 0. Each venue's marginal rate only worsens with size, so
     * the total is unimodal in the split and a ternary search finds the optimum. Integer rounding
     * makes it slightly ragged, so the search stops at `tolerance` (default amount / 1e6, at
     * least 2) and the finalists, plus both single-venue ends, are compared directly.
     *
     * Returns { a, b, total } (a + b = amount, a to venue A), or null if both venues together
     * cannot take the amount.
     */
    function splitSwap(valueA, valueB, amount, { minimise = false, tolerance } = {}) {
        amount = big(amount);
        if (amount <= 0n) return null;
        const feasible = (f, x) => x <= 0n || f(x) !== null;
        // Largest x in [0, amount] the venue can take (feasibility only shrinks as x grows)
        const reach = f => {
            if (feasible(f, amount)) return amount;
            let lo = 0n, hi = amount;
            while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (feasible(f, mid)) lo = mid; else hi = mid; }
            return lo;
        };
        const aMax = reach(valueA), aMin = amount - reach(valueB);
        if (aMin > aMax) return null;

        const total = a => {
            const va = a > 0n ? valueA(a) : 0n, vb = a < amount ? valueB(amount - a) : 0n;
            return va === null || vb === null ? null : va + vb;
        };
        const better = (t1, t2) => t2 === null || (t1 !== null && (minimise ? t1 < t2 : t1 > t2));
        let tol = tolerance == null ? amount / 1000000n : big(tolerance);
        if (tol < 2n) tol = 2n;

        let lo = aMin, hi = aMax;
        while (hi - lo > tol) {
            const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
            if (better(total(m1), total(m2))) hi = m2; else lo = m1;
        }
        let best = null;
        for (const a of [aMin, aMax, lo, (lo + hi) / 2n, hi]) {
            const t = total(a);
            if (t !== null && (best === null || better(t, best.total))) best = { a, b: amount - a, total: t };
        }
        return best;
    }

    /** Network fee for operation `opCode` from get_global_properties, in core-asset satoshis (null if absent). */
    function opFee(globalProps, opCode) {
        const fees = globalProps && globalProps.parameters && globalProps.parameters.current_fees;
        if (!fees || !Array.isArray(fees.parameters)) return null;
        const entry = fees.parameters.find(p => Array.isArray(p) && p[0] === opCode);
        if (!entry || !entry[1] || entry[1].fee == null) return null;
        return big(entry[1].fee) * big(fees.scale == null ? PERCENT_100 : fees.scale) / PERCENT_100;
    }

    // ---------- LP share valuation ----------
    /**
     * Values an LP share in USD using on-chain pool depth and reference prices.
     *
     * Precedence rule (Pool Stats Lite canonical logic):
     * 1. If either asset is a USD asset: usdDepth = 2 * balUSD.
     * 2. Else if either asset is BTS: usdDepth = 2 * balBTS * usdPerBts.
     *    (A BTS leg comes BEFORE a BTC leg so BTWTY.BTC pool 1.19.539 is valued
     *     from its BTS side, avoiding assuming BTWTY.BTC trades at XBTSX.BTC parity).
     * 3. Else if either asset is BTC: usdDepth = 2 * balBTC * usdPerBtc.
     *
     * @param {Object} pool - Pool object (balance_a, balance_b)
     * @param {Object} assetA - Asset A { symbol, precision }
     * @param {Object} assetB - Asset B { symbol, precision }
     * @param {number|string|BigInt} shareSupply - Total current supply of LP share token
     * @param {Object} usdRefs - { usdPerBts, usdPerBtc }
     * @returns {Object} { usdDepthValue, lpUsdValue, btcDepthValue }
     */
    function valueLpShareUsd(pool, assetA, assetB, shareSupply, usdRefs = {}) {
        const balA = parseInt(pool.balance_a, 10) / Math.pow(10, assetA.precision || 5);
        const balB = parseInt(pool.balance_b, 10) / Math.pow(10, assetB.precision || 5);
        const supply = Number(shareSupply) || 0;

        const symA = assetA.symbol || "";
        const symB = assetB.symbol || "";

        let btcDepthValue = -1;
        if (BTC_ASSETS.includes(symA)) btcDepthValue = balA * 2;
        else if (BTC_ASSETS.includes(symB)) btcDepthValue = balB * 2;

        let usdDepthValue = 0;
        const usdPerBts = Number(usdRefs.usdPerBts) || 0;
        const usdPerBtc = Number(usdRefs.usdPerBtc) || 0;

        if (USD_ASSETS.includes(symA)) usdDepthValue = 2 * balA;
        else if (USD_ASSETS.includes(symB)) usdDepthValue = 2 * balB;
        else if (symA === "BTS" && usdPerBts > 0) usdDepthValue = 2 * balA * usdPerBts;
        else if (symB === "BTS" && usdPerBts > 0) usdDepthValue = 2 * balB * usdPerBts;
        else if (BTC_ASSETS.includes(symA) && usdPerBtc > 0) usdDepthValue = 2 * balA * usdPerBtc;
        else if (BTC_ASSETS.includes(symB) && usdPerBtc > 0) usdDepthValue = 2 * balB * usdPerBtc;

        const lpUsdValue = supply > 0 ? usdDepthValue / supply : 0;

        return {
            usdDepthValue,
            lpUsdValue,
            btcDepthValue
        };
    }

    /**
     * Day-One Fair Value: deconstructs an LP share into its constituent Asset A and Asset B
     * amounts, evaluates each leg independently against the lending/quote asset price, and sums them.
     */
    function dayOneLpFairValue(pool, assetA, assetB, priceA, priceB, shareSupply) {
        const balA = parseInt(pool.balance_a, 10) / Math.pow(10, assetA.precision || 5);
        const balB = parseInt(pool.balance_b, 10) / Math.pow(10, assetB.precision || 5);
        const supply = Number(shareSupply) || 0;

        const aPerShare = supply > 0 ? balA / supply : 0;
        const bPerShare = supply > 0 ? balB / supply : 0;

        const valA = aPerShare * Number(priceA || 0);
        const valB = bPerShare * Number(priceB || 0);
        const dayOneFairValue = valA + valB;

        const pctA = dayOneFairValue > 0 ? (valA / dayOneFairValue) * 100 : 50;
        const pctB = dayOneFairValue > 0 ? (valB / dayOneFairValue) * 100 : 50;

        return {
            dayOneFairValue,
            valA,
            valB,
            pctA,
            pctB,
            aPerShare,
            bPerShare,
            balA,
            balB,
            shareSupply: supply
        };
    }

    /**
     * Calculates Price Per Share (PPS) metrics for a BitShares liquidity pool.
     *
     * Metrics computed:
     * - ppsK: Invariant geometric PPS = sqrt(balA * balB) / supply.
     *         Pure nominal fee-accrual metric invariant to price changes.
     * - ppsA: Numeraire PPS in Asset A = 2 * balA / supply.
     * - ppsB: Numeraire PPS in Asset B = 2 * balB / supply.
     * - aPerShare, bPerShare: Direct underlying redemption claims per 1 share.
     * - spotPriceAInB: Spot rate of 1 A in B = balB / balA.
     * - spotPriceBInA: Spot rate of 1 B in A = balA / balB.
     * - lpUsdValue: Optional USD valuation per share if usdRefs provided.
     *
     * @param {Object} pool - Pool object (balance_a, balance_b)
     * @param {Object} assetA - Asset A { symbol, precision }
     * @param {Object} assetB - Asset B { symbol, precision }
     * @param {number|string|BigInt} shareSupply - Circulating LP share supply
     * @param {Object} [options={}] - { sharePrecision, usdRefs }
     */
    function calculatePoolPps(pool, assetA, assetB, shareSupply, options = {}) {
        const precA = assetA && assetA.precision !== undefined ? assetA.precision : 5;
        const precB = assetB && assetB.precision !== undefined ? assetB.precision : 5;
        const balA = parseInt(pool.balance_a, 10) / Math.pow(10, precA);
        const balB = parseInt(pool.balance_b, 10) / Math.pow(10, precB);

        let supply = Number(shareSupply) || 0;
        if (options.sharePrecision !== undefined && options.sharePrecision !== null && supply > 1e6) {
            supply = supply / Math.pow(10, options.sharePrecision);
        }

        const aPerShare = supply > 0 ? balA / supply : 0;
        const bPerShare = supply > 0 ? balB / supply : 0;
        const ppsK = supply > 0 ? Math.sqrt(balA * balB) / supply : 0;
        const ppsA = supply > 0 ? (2 * balA) / supply : 0;
        const ppsB = supply > 0 ? (2 * balB) / supply : 0;
        const spotPriceAInB = balA > 0 ? balB / balA : 0;
        const spotPriceBInA = balB > 0 ? balA / balB : 0;

        let lpUsdValue = 0;
        if (options.usdRefs) {
            const usdVal = valueLpShareUsd(pool, assetA, assetB, supply, options.usdRefs);
            lpUsdValue = usdVal.lpUsdValue;
        }

        return {
            balA,
            balB,
            shareSupply: supply,
            aPerShare,
            bPerShare,
            ppsK,
            ppsA,
            ppsB,
            spotPriceAInB,
            spotPriceBInA,
            lpUsdValue
        };
    }

    /**
     * Calculates period return, annualized simple yield (APR) and compounded yield (APY)
     * from a baseline PPS observation to a current PPS observation over an elapsed time window.
     *
     * @param {number} currentPps - Current PPS
     * @param {number} baselinePps - Historical baseline PPS
     * @param {number} elapsedMs - Elapsed time in milliseconds
     * @returns {Object} { growthPct, aprPct, apyPct, elapsedDays }
     */
    function calculatePpsYield(currentPps, baselinePps, elapsedMs) {
        currentPps = Number(currentPps) || 0;
        baselinePps = Number(baselinePps) || 0;
        elapsedMs = Number(elapsedMs) || 0;

        if (baselinePps <= 0 || currentPps <= 0 || elapsedMs <= 0) {
            return {
                growthPct: 0,
                aprPct: 0,
                apyPct: 0,
                elapsedDays: 0
            };
        }

        const elapsedDays = elapsedMs / 86400000;
        if (elapsedDays < 0.0001) {
            return {
                growthPct: 0,
                aprPct: 0,
                apyPct: 0,
                elapsedDays
            };
        }

        const ratio = currentPps / baselinePps;
        const growth = ratio - 1;
        const periodsPerYear = 365.25 / elapsedDays;

        const apr = growth * periodsPerYear;
        let apy = 0;
        if (ratio > 0 && periodsPerYear < 50000) {
            apy = Math.pow(ratio, periodsPerYear) - 1;
        } else {
            apy = apr;
        }

        return {
            growthPct: growth * 100,
            aprPct: apr * 100,
            apyPct: isFinite(apy) ? apy * 100 : apr * 100,
            elapsedDays
        };
    }

    return {
        PERCENT_100,
        DEFAULT_SLIPPAGE_PERMILLE,
        USD_ASSETS,
        BTC_ASSETS,
        big,
        ceilDiv,
        bigMin,
        bigMax,
        poolHas,
        otherAsset,
        reserves,
        marketFee,
        calculatePoolSwap,
        pairedAmount,
        poolAfterSwap,
        estimateDeposit,
        estimateZap,
        walkOrderBook,
        inputForOutput,
        splitSwap,
        opFee,
        valueLpShareUsd,
        dayOneLpFairValue,
        calculatePoolPps,
        calculatePpsYield
    };
});
