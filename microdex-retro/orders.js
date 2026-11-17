/*
 * microDEX order helpers: exact decimal-to-unit conversion, limit order and cancel operations,
 * bundle assembly, funding checks and price ladders. No DOM or network access.
 *
 * Assets are passed as { id, prec } (prec = the asset's on-chain precision).
 *
 * Browser: exposes window.MicrodexOrders. Node: module.exports.
 */
(function (root, factory) {
    const lib = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = lib;
    } else {
        root.MicrodexOrders = lib;
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const MAX_LADDER_STEPS = 50;
    // Extra decimals a ladder keeps beyond its inputs, so interpolated prices aren't cut short
    const LADDER_EXTRA_SCALE = 8;

    // "12.345" -> { n: 12345n, scale: 3 }. Also takes exponent forms ("1e-7") from number inputs.
    function parseDecimal(value) {
        let s = String(value).trim();
        if (/e/i.test(s)) {
            const num = Number(s);
            if (!Number.isFinite(num) || num < 0) throw new Error(`Not a positive decimal number: "${value}"`);
            s = num.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
        }
        const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
        if (!m || (m[1] + (m[2] || "")) === "") throw new Error(`Not a positive decimal number: "${value}"`);
        const frac = m[2] || "";
        return { n: BigInt((m[1] || "0") + frac), scale: frac.length };
    }

    // a / b rounded half up (a >= 0, b > 0)
    function roundDiv(a, b) {
        return (a * 2n + b) / (2n * b);
    }

    // An integer at `scale` decimals, moved to `prec` decimals (rounded half up)
    function rescale(n, scale, prec) {
        return prec >= scale ? n * 10n ** BigInt(prec - scale) : roundDiv(n, 10n ** BigInt(scale - prec));
    }

    function formatDecimal(n, scale) {
        if (scale === 0) return n.toString();
        const s = n.toString().padStart(scale + 1, "0");
        return (s.slice(0, -scale) + "." + s.slice(-scale)).replace(/\.?0+$/, "");
    }

    // Decimal string -> integer units at `prec` decimals
    function toUnits(value, prec) {
        const d = parseDecimal(value);
        return rescale(d.n, d.scale, prec);
    }

    // a × b (decimal strings) -> integer units at `prec` decimals, with no floating point
    function productUnits(a, b, prec) {
        const da = parseDecimal(a), db = parseDecimal(b);
        return rescale(da.n * db.n, da.scale + db.scale, prec);
    }

    /*
     * limit_order_create (op 1) for `amount` of base at `price` quote per base.
     * Buy sells quote for base; sell sells base for quote. Throws if either side rounds to zero.
     */
    function limitOrderOp({ side, price, amount, base, quote, seller, expiration }) {
        if (side !== "buy" && side !== "sell") throw new Error(`Unknown order side "${side}"`);
        const baseUnits = toUnits(amount, base.prec);
        const quoteUnits = productUnits(amount, price, quote.prec);
        if (baseUnits <= 0n) throw new Error(`Amount ${amount} rounds to zero at ${base.prec} decimals`);
        if (quoteUnits <= 0n) throw new Error(`Order total ${amount} × ${price} rounds to zero at ${quote.prec} decimals`);
        const baseAsset = { amount: baseUnits.toString(), asset_id: base.id };
        const quoteAsset = { amount: quoteUnits.toString(), asset_id: quote.id };
        return [
            1,
            {
                fee: { amount: "0", asset_id: "1.3.0" },
                seller,
                amount_to_sell: side === "buy" ? quoteAsset : baseAsset,
                min_to_receive: side === "buy" ? baseAsset : quoteAsset,
                expiration,
                fill_or_kill: false,
                extensions: {}
            }
        ];
    }

    function cancelOp(seller, orderId) {
        return [
            2,
            {
                fee: { amount: "0", asset_id: "1.3.0" },
                fee_paying_account: seller,
                order: orderId,
                extensions: []
            }
        ];
    }

    // Open orders (get_full_accounts limit_orders) trading in any of `pairs` ([[assetId, assetId], ...]), either side
    function ordersInMarkets(limitOrders, pairs) {
        return (limitOrders || []).filter((o) => pairs.some((pair) =>
            pair.includes(o.sell_price.base.asset_id) && pair.includes(o.sell_price.quote.asset_id)));
    }

    // Cancels first, so the funds they free are there for the new orders
    function bundleOps(cancels, entries) {
        return [...cancels, ...entries.map((e) => e.op)];
    }

    // { assetId: BigInt } summed amount_to_sell of every limit_order_create in `ops`
    function sellTotals(ops) {
        const totals = {};
        for (const [code, body] of ops) {
            if (code !== 1) continue;
            const id = body.amount_to_sell.asset_id;
            totals[id] = (totals[id] || 0n) + BigInt(body.amount_to_sell.amount);
        }
        return totals;
    }

    /*
     * Assets the orders in `ops` sell more of than the account holds, counting what `cancelled`
     * open orders give back. `balances` is get_full_accounts' balances list. Fees are not included.
     */
    function shortfalls(ops, balances, cancelled = []) {
        const available = {};
        for (const b of balances || []) available[b.asset_type] = (available[b.asset_type] || 0n) + BigInt(b.balance);
        for (const o of cancelled) {
            const id = o.sell_price.base.asset_id;
            available[id] = (available[id] || 0n) + BigInt(o.for_sale);
        }
        return Object.entries(sellTotals(ops))
            .filter(([id, needed]) => needed > (available[id] || 0n))
            .map(([id, needed]) => ({ asset_id: id, needed, available: available[id] || 0n }));
    }

    /*
     * `steps` orders evenly spaced from `low` to `high` (either order), splitting `total` evenly.
     * Returns [{ price, amount }] as decimal strings, lowest price first.
     */
    function ladder({ low, high, steps, total }) {
        steps = Number(steps);
        if (!Number.isInteger(steps) || steps < 1 || steps > MAX_LADDER_STEPS) {
            throw new Error(`Steps must be a whole number from 1 to ${MAX_LADDER_STEPS}`);
        }
        const dl = parseDecimal(low), dh = parseDecimal(high), dt = parseDecimal(total);
        const scale = Math.max(dl.scale, dh.scale, dt.scale) + LADDER_EXTRA_SCALE;
        let lo = rescale(dl.n, dl.scale, scale), hi = rescale(dh.n, dh.scale, scale);
        const sum = rescale(dt.n, dt.scale, scale);
        if (lo > hi) [lo, hi] = [hi, lo];
        if (lo <= 0n) throw new Error("Ladder prices must be above zero");
        if (sum <= 0n) throw new Error("Ladder total amount must be above zero");
        const each = formatDecimal(roundDiv(sum, BigInt(steps)), scale);
        return Array.from({ length: steps }, (_, i) => ({
            price: formatDecimal(steps === 1 ? lo : lo + roundDiv((hi - lo) * BigInt(i), BigInt(steps - 1)), scale),
            amount: each
        }));
    }

    /*
     * What a ladder's orders trade, for a preview before they are added: each rung with its base and
     * quote amounts in integer units, exactly as limitOrderOp will put them on chain, and their sums.
     * Throws limitOrderOp's error when a rung rounds to zero.
     */
    function ladderTotals(rungs, base, quote) {
        let baseSum = 0n, quoteSum = 0n;
        const rows = rungs.map((r) => {
            const [, body] = limitOrderOp({ side: "sell", price: r.price, amount: r.amount, base, quote, seller: "", expiration: "" });
            const baseUnits = BigInt(body.amount_to_sell.amount), quoteUnits = BigInt(body.min_to_receive.amount);
            baseSum += baseUnits;
            quoteSum += quoteUnits;
            return { price: r.price, amount: r.amount, base: baseUnits, quote: quoteUnits };
        });
        return { rows, base: baseSum, quote: quoteSum };
    }

    return {
        MAX_LADDER_STEPS,
        parseDecimal,
        formatDecimal,
        toUnits,
        productUnits,
        limitOrderOp,
        cancelOp,
        ordersInMarkets,
        bundleOps,
        sellTotals,
        shortfalls,
        ladder,
        ladderTotals
    };
});
