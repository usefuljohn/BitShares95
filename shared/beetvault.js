/*
 * BeetVault signing helpers shared by the desktop apps (and mirrored by refinance-01/refinance_cli.py).
 *
 * Transactions leave the page only as a BeetVault request saved to a .json file, which is
 * uploaded with BeetVault's local JSON file option (no size limit). Keys never touch the page.
 * Reference: https://github.com/beetapp/beeteos (docs/en/developer-guide.md)
 *
 * Browser: exposes window.BeetVault. Node: module.exports.
 */
(function (root, factory) {
    const lib = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = lib;
    } else {
        root.BeetVault = lib;
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const DEFAULT_EXPIRE_SECONDS = 3600;

    function uuid() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    // Chain time (Date, or a chain "YYYY-MM-DDTHH:MM:SS" string) plus `seconds`, as a chain timestamp.
    function expirationFrom(chainTime, seconds = DEFAULT_EXPIRE_SECONDS) {
        const base = chainTime instanceof Date
            ? chainTime
            : chainTime ? new Date(/[zZ]$/.test(chainTime) ? chainTime : chainTime + "Z") : new Date();
        return new Date(base.getTime() + seconds * 1000).toISOString().split(".")[0];
    }

    /*
     * The signAndBroadcast request envelope. Fees and the reference block are left as placeholders;
     * BeetVault sets them (set_required_fees / update_head_block) before signing.
     */
    function buildRequest(operations, { appName, expiration, chain = "BTS", browser = "web browser", origin = (typeof location !== "undefined" && location.hostname) || "localhost", memo = false, id = uuid() }) {
        const tx = {
            ref_block_num: 0,
            ref_block_prefix: 0,
            expiration,
            operations,
            extensions: [],
            signatures: []
        };
        return {
            type: "api",
            id,
            payload: {
                method: "injectedCall",
                params: ["signAndBroadcast", JSON.stringify(tx), []],
                appName,
                chain,
                browser,
                origin,
                memo
            }
        };
    }

    function requestJson(request) {
        return JSON.stringify(request, null, 2);
    }

    // The transaction inside a request, or null when it can't be read
    function transactionOf(request) {
        try {
            return JSON.parse(request.payload.params[1]);
        } catch (_) {
            return null;
        }
    }

    // When the wallet stops accepting the request: BeetVault signs with this expiration as it stands
    function expiresAt(request) {
        const tx = transactionOf(request);
        const at = tx && typeof tx.expiration === "string" ? new Date(tx.expiration + "Z") : null;
        return at && !isNaN(at) ? at : null;
    }

    function isExpired(request, now = Date.now()) {
        const at = expiresAt(request);
        return Boolean(at && at.getTime() <= now);
    }

    const utcTime = (date) => `${date.toISOString().slice(11, 16)} UTC`;

    // The field naming the account that must sign, by operation id
    const SIGNER_FIELDS = {
        0: "from", 1: "seller", 2: "fee_paying_account", 3: "funding_account",
        61: "account", 62: "account", 63: "account",
        69: "owner_account", 70: "owner_account", 71: "owner_account", 72: "borrower", 73: "account"
    };

    // Account ids (1.2.x) the request's operations sign for: the account to select in the wallet
    function signerIds(request) {
        const tx = transactionOf(request);
        const ids = ((tx && tx.operations) || []).map((op) => op && op[1] && op[1][SIGNER_FIELDS[op[0]]]);
        return [...new Set(ids.filter((id) => typeof id === "string" && /^1\.2\.\d+$/.test(id)))];
    }

    // "name (1.2.x)" when the app passed the account's name, else the id alone; "" when unknown
    function signerLabel(request, name) {
        const ids = signerIds(request).join(" + ");
        if (name && ids && name !== ids) return `${name} (${ids})`;
        return name || ids;
    }

    function refuseExpired(request) {
        if (!isExpired(request)) return false;
        notify("Request expired",
            `This request expired at ${utcTime(expiresAt(request))} by this computer's clock, so the wallet would reject it. Change an input to rebuild it.`);
        return true;
    }

    /*
     * Browser only: save the request as a JSON file for BeetVault's local file upload, and tell the
     * user which account to select and how long the file stays valid. `signer` is that account's
     * name when the app has it. Returns false (and saves nothing) when the request has expired.
     */
    function downloadRequest(request, filename, { signer } = {}) {
        if (refuseExpired(request)) return false;
        const blob = new Blob([requestJson(request)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        const account = signerLabel(request, signer);
        const until = expiresAt(request);
        notify("Request saved",
            `In BeetVault, open Local JSON file${account ? `, pick ${account}` : ""} and upload ${filename}${until ? ` before ${utcTime(until)}` : ""}.`);
        return true;
    }

    // Browser only: copies `text` and says so, or says the clipboard is unavailable. Resolves true when copied.
    async function copyText(text, what = "Transaction JSON") {
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            notify("Clipboard unavailable", `${what} was not copied. Use Download JSON instead.`);
            return false;
        }
        notify("Copied", `${what} copied to the clipboard.`);
        return true;
    }

    const DEFAULT_SCHEME = "rawbeetvault";

    // Longest text a wallet accepts after "<scheme>://api/". BeetVault drops longer rawbeetvault:// links;
    // other wallets publish no cap, so SOFT_DEEPLINK_LIMIT only triggers a warning for them.
    const DEEPLINK_LIMITS = { rawbeetvault: 4096 };
    const SOFT_DEEPLINK_LIMIT = 2000;

    function getWalletScheme() {
        try {
            if (typeof window !== "undefined" && window.B95 && window.B95.context && window.B95.context.walletScheme) {
                return window.B95.context.walletScheme;
            }
        } catch (_) {}
        try {
            if (typeof localStorage !== "undefined") {
                const saved = localStorage.getItem("b95-wallet-scheme");
                if (saved) return saved;
            }
        } catch (_) {}
        return DEFAULT_SCHEME;
    }

    function setWalletScheme(scheme) {
        try {
            if (typeof localStorage !== "undefined") {
                localStorage.setItem("b95-wallet-scheme", scheme);
            }
        } catch (_) {}
    }

    function getDeeplink(request, scheme = getWalletScheme()) {
        // Compact JSON: a URL has no use for indentation and some handlers cap its length
        const payloadStr = typeof request === "string" ? request : JSON.stringify(request);
        // BeetVault reads only `request` (its documented form); other Beet wallets also take `chain`
        if (scheme === "rawbeetvault") return `${scheme}://api/?request=${encodeURIComponent(payloadStr)}`;
        let chain = "BTS";
        try {
            const parsed = typeof request === "string" ? JSON.parse(request) : request;
            if (parsed?.payload?.chain) chain = parsed.payload.chain;
        } catch (_) {}
        return `${scheme}://api/?chain=${encodeURIComponent(chain)}&request=${encodeURIComponent(payloadStr)}`;
    }

    // Length the wallet checks against its limit: the link minus "<scheme>://api/"
    function deeplinkLength(request, scheme = getWalletScheme()) {
        return getDeeplink(request, scheme).length - `${scheme}://api/`.length;
    }

    // False when the wallet would drop the link for its size; save the request as JSON instead
    function deeplinkFits(request, scheme = getWalletScheme()) {
        return !(scheme in DEEPLINK_LIMITS) || deeplinkLength(request, scheme) <= DEEPLINK_LIMITS[scheme];
    }

    function notify(title, msg) {
        if (typeof window !== "undefined" && window.B95 && typeof window.B95.notify === "function") {
            window.B95.notify(title, msg);
        } else if (typeof console !== "undefined") {
            console.warn(`[${title}] ${msg}`);
        }
    }

    // Opens the request in the wallet. Returns false (and opens nothing) when the request has expired
    // or the link is too long for the wallet.
    function launchDeeplink(request, scheme = getWalletScheme()) {
        if (refuseExpired(request)) return false;
        const length = deeplinkLength(request, scheme);
        if (!deeplinkFits(request, scheme)) {
            notify("Too large for a deeplink",
                `This request is ${length} characters as a ${scheme}:// link; the wallet accepts at most ${DEEPLINK_LIMITS[scheme]}. Use Download JSON and upload the file in BeetVault instead.`);
            return false;
        }
        if (!(scheme in DEEPLINK_LIMITS) && length > SOFT_DEEPLINK_LIMIT) {
            notify("Large Transaction", "This bundle exceeds 2KB URL limits; downloading JSON is recommended.");
        }
        if (scheme === "rawbeetvault") {
            notify("BeetVault deeplink",
                `BeetVault signs it only while unlocked on its Raw Deeplink page, with the allowed operations chosen and ${signerLabel(request) || "this transaction's account"} selected.`);
        }
        const url = getDeeplink(request, scheme);
        if (typeof window !== "undefined" && window.B95 && typeof window.B95.openDeeplink === "function") {
            window.B95.openDeeplink(url);
        } else if (typeof document !== "undefined") {
            const a = document.createElement("a");
            a.href = url;
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
        return true;
    }

    return {
        DEFAULT_SCHEME,
        DEFAULT_EXPIRE_SECONDS,
        DEEPLINK_LIMITS,
        uuid,
        expirationFrom,
        buildRequest,
        requestJson,
        expiresAt,
        isExpired,
        signerIds,
        downloadRequest,
        copyText,
        getWalletScheme,
        setWalletScheme,
        getDeeplink,
        deeplinkLength,
        deeplinkFits,
        launchDeeplink
    };
});
