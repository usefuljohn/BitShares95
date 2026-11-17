/*
 * Transfer engine: exact amount handling and the transfer operation (op 0) for asset-transfer/.
 *
 * Amounts never pass through floating point: decimal text is split into whole and fraction digits
 * and scaled by the asset's precision as a BigInt, so "0.29" at precision 6 is exactly 290000.
 *
 * Browser: exposes window.TransferEngine. Node: module.exports (see tests/test_transfer.js).
 */
(function (root, factory) {
    const lib = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = lib;
    } else {
        root.TransferEngine = lib;
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const CORE_ASSET_ID = "1.3.0";
    const MAX_INT64 = 9223372036854775807n; // GRAPHENE_MAX_SHARE_SUPPLY bounds every amount on chain
    const GRAPHENE_100_PERCENT = 10000n;

    const ACCOUNT_ID = /^1\.2\.\d+$/;
    const ASSET_ID = /^1\.3\.\d+$/;
    // Asset symbols: upper-case letters and digits, optionally dotted (XBTSX.USDT), 3 to 16 characters
    const ASSET_SYMBOL = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/;

    // asset_issuer_permission_flags (libraries/protocol/include/graphene/protocol/types.hpp)
    const FLAGS = {
        white_list: 0x02,
        transfer_restricted: 0x08,
    };

    // Asset input → { kind: 'id' | 'symbol', key } or null when it can be neither
    function parseAssetInput(text) {
        const key = String(text == null ? "" : text).trim();
        if (ASSET_ID.test(key)) return { kind: "id", key };
        const sym = key.toUpperCase();
        if (sym.length >= 3 && sym.length <= 16 && ASSET_SYMBOL.test(sym)) return { kind: "symbol", key: sym };
        return null;
    }

    /*
     * Decimal text → { ok: true, units: BigInt } in the asset's smallest units, or { ok: false, error }.
     * More decimals than the asset has is an error, not a silent cut, unless the extra digits are zeros.
     */
    function parseAmount(text, precision) {
        const s = String(text == null ? "" : text).trim();
        if (!s) return { ok: false, error: "Enter an amount" };
        if (s.includes(",")) return { ok: false, error: "Use a dot for decimals and no thousands separators" };
        const m = s.match(/^(\d*)(?:\.(\d*))?$/);
        if (!m || (!m[1] && !m[2])) return { ok: false, error: "Amount must be a plain positive number, like 12.5" };
        const whole = m[1] || "0";
        let frac = m[2] || "";
        if (frac.length > precision) {
            if (/[^0]/.test(frac.slice(precision))) {
                return { ok: false, error: `This asset allows at most ${precision} decimal place${precision === 1 ? "" : "s"}` };
            }
            frac = frac.slice(0, precision);
        }
        const units = BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, "0") || "0");
        if (units <= 0n) return { ok: false, error: "Amount must be more than zero" };
        if (units > MAX_INT64) return { ok: false, error: "Amount is larger than any BitShares asset can hold" };
        return { ok: true, units };
    }

    // Smallest units → decimal text; trailing fraction zeros dropped unless `trim` is false
    function formatAmount(units, precision, { trim = true } = {}) {
        let v = BigInt(units);
        const neg = v < 0n;
        if (neg) v = -v;
        const s = v.toString().padStart(precision + 1, "0");
        const whole = s.slice(0, s.length - precision);
        let frac = precision > 0 ? s.slice(s.length - precision) : "";
        if (trim) frac = frac.replace(/0+$/, "");
        return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
    }

    // Transfer fee in BTS units from get_global_properties, scaled as the chain scales it (no memo, so no data fee)
    function transferFee(globalProps) {
        const fees = globalProps && globalProps.parameters && globalProps.parameters.current_fees;
        if (!fees || !Array.isArray(fees.parameters)) return null;
        const entry = fees.parameters.find(p => Array.isArray(p) && p[0] === 0);
        if (!entry || !entry[1] || entry[1].fee == null) return null;
        const scale = BigInt(fees.scale == null ? GRAPHENE_100_PERCENT : fees.scale);
        return BigInt(entry[1].fee) * scale / GRAPHENE_100_PERCENT;
    }

    // Largest amount that can be sent: for BTS, the balance less the network fee
    function maxSendable(balance, assetId, fee) {
        const bal = BigInt(balance || 0);
        const reserve = assetId === CORE_ASSET_ID && fee != null ? BigInt(fee) : 0n;
        return bal > reserve ? bal - reserve : 0n;
    }

    /*
     * Checks a transfer before building it.
     *   from, to   account objects ({ id, name })
     *   asset      asset object from the chain (id, symbol, precision, issuer, options)
     *   units      BigInt amount in smallest units
     *   balance    BigInt balance of `asset` held by `from`
     *   coreBalance BigInt BTS balance of `from` (pays the fee)
     *   fee        BigInt estimated fee in BTS units, or null when unknown
     * Returns { errors: [...], warnings: [...] }; build only when errors is empty.
     */
    function checkTransfer({ from, to, asset, units, balance, coreBalance, fee }) {
        const errors = [];
        const warnings = [];
        if (from && to && from.id === to.id) errors.push("From and To are the same account");
        if (asset && units != null) {
            const bal = BigInt(balance || 0);
            if (units > bal) {
                errors.push(`Amount is more than the available ${formatAmount(bal, asset.precision)} ${asset.symbol}`);
            } else if (fee != null) {
                const core = BigInt(coreBalance || 0);
                const needCore = (asset.id === CORE_ASSET_ID ? units : 0n) + BigInt(fee);
                if (needCore > core) {
                    errors.push(asset.id === CORE_ASSET_ID
                        ? `Amount plus the ~${formatAmount(fee, 5)} BTS fee is more than the BTS balance; use Max`
                        : `Not enough BTS for the ~${formatAmount(fee, 5)} BTS network fee`);
                }
            }
        }
        if (asset && asset.options) {
            const flags = Number(asset.options.flags || 0);
            if (flags & FLAGS.transfer_restricted && from && to && from.id !== asset.issuer && to.id !== asset.issuer) {
                errors.push(`${asset.symbol} is transfer-restricted: it can only be sent to or from its issuer`);
            }
            const wl = asset.options.whitelist_authorities || [];
            const bl = asset.options.blacklist_authorities || [];
            if (flags & FLAGS.white_list && (wl.length || bl.length)) {
                warnings.push(`${asset.symbol} uses ${wl.length ? "whitelists" : "blacklists"}: the transfer fails if either account isn't allowed to hold it`);
            }
        }
        if (fee == null) warnings.push("Network fee unknown; BeetVault sets it when signing");
        return { errors, warnings };
    }

    // The transfer operation; the fee is a placeholder BeetVault fills in before signing
    function buildTransferOp({ from, to, assetId, units }) {
        if (!ACCOUNT_ID.test(from || "")) throw new Error(`Bad from account ID: ${from}`);
        if (!ACCOUNT_ID.test(to || "")) throw new Error(`Bad to account ID: ${to}`);
        if (from === to) throw new Error("From and To are the same account");
        if (!ASSET_ID.test(assetId || "")) throw new Error(`Bad asset ID: ${assetId}`);
        const amount = BigInt(units);
        if (amount <= 0n || amount > MAX_INT64) throw new Error(`Bad amount: ${units}`);
        return [0, {
            fee: { amount: "0", asset_id: CORE_ASSET_ID },
            from,
            to,
            amount: { amount: amount.toString(), asset_id: assetId },
            extensions: []
        }];
    }

    return {
        CORE_ASSET_ID,
        MAX_INT64,
        FLAGS,
        parseAssetInput,
        parseAmount,
        formatAmount,
        transferFee,
        maxSendable,
        checkTransfer,
        buildTransferOp
    };
});
