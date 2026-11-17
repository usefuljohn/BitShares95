/**
 * Gateway Board configurations. index.html draws one tab per board, in this order (#<key> opens one).
 *
 * A board trades its base asset (route[0]) against its quote asset (route[last]) through the pools
 * between neighbouring route assets: BUY spends quote for base, SELL sells base for quote, both as
 * one all-or-nothing transaction of chained liquidity_pool_exchange (op 63) operations.
 *
 *   route          asset keys from SWAP_ASSETS, base first, quote last
 *   pools          pool ids between route[i] and route[i+1]
 *   metrics        'ask', 'bid', 'spread', or { label, usd: assetKey } for that asset's price in
 *                  USDT along the route (the route must pass through USDT)
 *   spreadNotional quote amount the ask / bid / spread quotes simulate
 *   quoteChips, satChips, baseChips   quick amounts under the inputs (MAX is always added)
 *   spotDp         decimals of the hero price, per quote unit ('btc' / 'sat', or 'quote' when
 *                  the quote isn't BTC)
 *   inverse        { per, dp } per quote unit: "per <quote> ≈ x <base>"
 *   tab            the board's tab label
 *   legacyAccountKey  localStorage key the board's old standalone app saved its account under; read
 *                  as a fallback when the page has no account of its own yet
 *   filePrefix     name of the downloaded BeetVault request file
 */
(function (root) {
  'use strict';

  // precision: chain decimals. dp: decimals shown for amounts. short: the label used in the UI.
  const SWAP_ASSETS = {
    BTS:  { id: '1.3.0',    symbol: 'BTS',        short: 'BTS',  precision: 5, dp: 4 },
    XRP:  { id: '1.3.5537', symbol: 'IOB.XRP',    short: 'XRP',  precision: 4, dp: 4 },
    USDT: { id: '1.3.5589', symbol: 'XBTSX.USDT', short: 'USDT', precision: 6, dp: 2 },
    BTC:  { id: '1.3.6637', symbol: 'BTWTY.BTC',  short: 'BTC',  precision: 8, dp: 8 },
    XAUT: { id: '1.3.6139', symbol: 'XBTSX.XAUT', short: 'XAUT', precision: 6, dp: 6 },
  };

  const SWAP_BOARDS = {
    'xrp-usdt': {
      title: 'XRP // USDT · 1-Hop Board',
      sub: 'AMM Relative Ratio Price Board & 2-Op Swap Bundler',
      appName: 'XRP·USDT Board',
      tab: 'XRP·USDT',
      route: ['XRP', 'BTS', 'USDT'],
      pools: ['1.19.133', '1.19.48'],
      metrics: ['ask', 'bid', 'spread'],
      spreadNotional: 10,
      quoteChips: [10, 25, 50, 100],
      baseChips: [25, 50, 100],
      spotDp: { quote: 4 },
      inverse: { quote: { per: 1, dp: 4 } },
      legacyAccountKey: 'xrp_usdt_account',
      filePrefix: 'xrp-usdt-swap',
    },
    'xrp-btc': {
      title: 'XRP // BTC · 1-Hop Board',
      sub: 'AMM Relative Ratio Price Board & 2-Op Swap Bundler',
      appName: 'XRP·BTC Board',
      tab: 'XRP·BTC',
      route: ['XRP', 'BTS', 'BTC'],
      pools: ['1.19.133', '1.19.539'],
      metrics: ['ask', 'bid', 'spread'],
      spreadNotional: 0.0001,
      quoteChips: [0.0005, 0.001, 0.005, 0.01],
      satChips: [1000, 5000, 10000, 50000],
      baseChips: [25, 50, 100],
      spotDp: { btc: 8, sat: 2 },
      inverse: { btc: { per: 1, dp: 2 }, sat: { per: 1000, dp: 4 } },
      legacyAccountKey: 'xrp_btc_account',
      filePrefix: 'xrp-btc-swap',
    },
    'btc-xaut': {
      title: 'BTC // XAUT · 3-Pool Board',
      sub: 'AMM 3-Pool Relative Ratio Board & 3-Op Swap Bundler',
      appName: 'BTC·XAUT Board',
      tab: 'BTC·XAUT',
      route: ['XAUT', 'USDT', 'BTS', 'BTC'],
      pools: ['1.19.473', '1.19.48', '1.19.539'],
      metrics: [{ label: 'Implied Gold', usd: 'XAUT' }, { label: 'Implied BTC', usd: 'BTC' }, 'spread'],
      spreadNotional: 0.0005,
      quoteChips: [0.0005, 0.001, 0.005, 0.01],
      satChips: [1000, 5000, 10000, 50000],
      baseChips: [0.001, 0.005, 0.01, 0.05],
      spotDp: { btc: 8, sat: 0 },
      inverse: { btc: { per: 1, dp: 4 }, sat: { per: 100000, dp: 6 } },
      legacyAccountKey: 'btc_xaut_account',
      filePrefix: 'btc-xaut-swap',
    },
  };

  root.SWAP_ASSETS = SWAP_ASSETS;
  root.SWAP_BOARDS = SWAP_BOARDS;
  if (typeof module === 'object' && module.exports) module.exports = { SWAP_ASSETS, SWAP_BOARDS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
