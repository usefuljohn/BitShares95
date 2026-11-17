/**
 * DaoStreet CreditFlow Engine (shared, zero dependency)
 *
 * The single source of truth for BitShares credit-offer valuation. Loaded by
 * CreditFlow's pages and other desktop apps via <script src>, and by Node tools via require().
 * Node 22+ provides the global WebSocket this relies on.
 *
 * Browser: window.CreditFlowEngine      Node: module.exports
 */
(function (root) {
  'use strict';

  // api.bts.mobi first: it keeps the most account history, which history
  // lookups by Node tools need
  const BITSHARES_NODES = (typeof window !== "undefined" && window.B95 && window.B95.NODE_URLS)
    ? window.B95.NODE_URLS
    : [
        "wss://api.bts.mobi/ws",
        "wss://node.xbts.io/ws",
        "wss://api.bitshares.bhuz.info/ws",
        "wss://btsws.roelandp.nl/ws",
        "wss://dex.iobanker.com/ws"
      ];

  // Gear membership mirrors Bob's dex-credit config (gears / monitored_offers).
  // managedBy 'bob' = in one of Bob's gears; 'human' = tracked here, managed by hand.
  const BOB_GEARS = {
    '1': { name: '1st Gear - USD' },
    '2': { name: '2nd Gear - XRP & BTS' },
    '3': { name: '3rd Gear - Gringotts Fiat' }
  };

  // Scrub gateway/issuer prefixes from asset symbols (e.g. XBTSX.USDC -> USDC, IOB.XRP -> XRP).
  // Preserves special symbols like XBTSX.A where the single-character symbol alone is ambiguous.
  function scrubAssetSymbol(sym) {
    if (!sym || typeof sym !== 'string') return '';
    if (sym === 'IOB.XRP') return 'XRP';
    if (sym.startsWith('XBTSX.') && sym !== 'XBTSX.A') return sym.slice(6);
    return sym;
  }

  const MONITORED_OFFERS = [
    { offerId: '1.21.542', symbol: 'USDT', assetId: '1.3.5589', pricing: 'stable', category: 'USD-pegged', managedBy: 'bob', gear: '1', account: 'bit20' },
    { offerId: '1.21.533', symbol: 'USDC', assetId: '1.3.5902', pricing: 'stable', category: 'USD-pegged', managedBy: 'bob', gear: '1', account: 'bit20' },
    { offerId: '1.21.681', symbol: 'HONEST.USD', assetId: '1.3.5649', pricing: 'stable', category: 'USD-pegged', managedBy: 'bob', gear: '3', account: 'gringotts' },
    { offerId: '1.21.593', symbol: 'BTS', assetId: '1.3.0', pricing: 'direct', poolId: '1.19.48', quoteAssetId: '1.3.5589', category: 'Crypto', managedBy: 'bob', gear: '2', account: 'bit20' },
    { offerId: '1.21.670', symbol: 'XRP', assetId: '1.3.5537', pricing: 'chained', poolId: '1.19.133', quoteAssetId: '1.3.0', chainedPoolId: '1.19.48', chainedQuoteAssetId: '1.3.5589', category: 'Crypto', managedBy: 'bob', gear: '2', account: 'gringotts' },
    { offerId: '1.21.672', symbol: 'XAUT', assetId: '1.3.6139', pricing: 'direct', poolId: '1.19.473', quoteAssetId: '1.3.5589', category: 'Commodity', managedBy: 'human' },
    { offerId: '1.21.669', symbol: 'bitRUBLE', assetId: '1.3.1325', pricing: 'chained', poolId: '1.19.231', quoteAssetId: '1.3.0', chainedPoolId: '1.19.48', chainedQuoteAssetId: '1.3.5589', category: 'Fiat', managedBy: 'bob', gear: '3', account: 'gringotts' },
    { offerId: '1.21.674', symbol: 'BITEUR', assetId: '1.3.120', pricing: 'chained', poolId: '1.19.59', quoteAssetId: '1.3.0', chainedPoolId: '1.19.48', chainedQuoteAssetId: '1.3.5589', category: 'Fiat', managedBy: 'bob', gear: '3', account: 'gringotts' },
    { offerId: '1.21.686', symbol: 'bitJPY', assetId: '1.3.119', pricing: 'chained', poolId: '1.19.186', quoteAssetId: '1.3.0', chainedPoolId: '1.19.48', chainedQuoteAssetId: '1.3.5589', category: 'Fiat', managedBy: 'bob', gear: '3', account: 'gringotts' },
    { offerId: '1.21.667', symbol: 'XBTSX.A', assetId: '1.3.6620', pricing: 'chained', poolId: '1.19.532', quoteAssetId: '1.3.0', chainedPoolId: '1.19.48', chainedQuoteAssetId: '1.3.5589', category: 'Crypto', managedBy: 'human' }
  ];
  // Other people's offers, shown only by pages that ask for them (offers.html);
  // every other caller stays on MONITORED_OFFERS
  const EXTERNAL_OFFERS = [
    { offerId: '1.21.687', symbol: 'USDT', assetId: '1.3.5589', pricing: 'stable', category: 'USD-pegged', managedBy: 'external', account: 'akledirs-account' },
    { offerId: '1.21.688', symbol: 'XBTSX.USDC', assetId: '1.3.5902', pricing: 'stable', category: 'USD-pegged', managedBy: 'external', account: 'akledirs-account' }
  ];
  [...MONITORED_OFFERS, ...EXTERNAL_OFFERS].forEach(cfg => { cfg.symbol = scrubAssetSymbol(cfg.symbol); });

  const CR_FLOOR_PCT = 110;            // Bob's cr_patrol DEFAULT_THRESHOLD
  const DEAL_PAGE_LIMIT = 101;         // Node-configured max for get_credit_deals_by_offer_id

  const REFERENCE_POOL_IDS = [
    '1.19.0', '1.19.248', '1.19.48', '1.19.133', '1.19.473',
    '1.19.539', '1.19.399', '1.19.116', '1.19.44', '1.19.465', '1.19.501',
    '1.19.507', '1.19.530', '1.19.231', '1.19.59', '1.19.63', '1.19.468', '1.19.532',
    '1.19.186'
  ];
  const REFERENCE_ASSET_IDS = ['1.3.0', '1.3.5589', '1.3.5902', '1.3.3291', '1.3.5773', '1.3.6139', '1.3.6520', '1.3.6235', '1.3.5649', '1.3.5537', '1.3.1325', '1.3.120', '1.3.6620'];

  // Connection state
  let currentWebSocket = null;
  let connectedHost = '';
  let messageId = 1;
  const pendingRequests = new Map();
  const objectCache = new Map();

  // Status listener: (state, text) with state in connecting | connected | disconnected | error
  // The last status is replayed to a listener registered later: in bridge mode
  // the desktop's context can arrive before the page calls onStatus().
  let statusListener = () => {};
  let lastStatus = null;
  function onStatus(fn) {
    statusListener = typeof fn === 'function' ? fn : () => {};
    if (lastStatus) statusListener(lastStatus.state, lastStatus.text);
  }
  function updateStatus(state, text) {
    lastStatus = { state, text };
    statusListener(state, text);
  }

  // Bridge mode helper: if embedded in BitShares Workstation desktop, use shared WebSocket via B95
  function isBridgeMode() {
    return typeof window !== 'undefined' && !!(window.B95 && window.B95.embedded);
  }

  function isConnected() {
    if (isBridgeMode()) {
      return window.B95.context?.node?.status === 'online';
    }
    return !!currentWebSocket && currentWebSocket.readyState === WebSocket.OPEN;
  }

  // WebSocket RPC Client (or B95 bridge when embedded)
  async function connectToNode() {
    if (isBridgeMode()) {
      if (isConnected()) return;
      updateStatus('connecting', 'Waiting for BitShares Workstation node...');
      // The desktop tries each of its nodes in turn (8 s apiece), so allow for that
      await new Promise((resolve) => {
        const timeout = setTimeout(done, BRIDGE_WAIT_MS);
        function done() {
          clearTimeout(timeout);
          const i = bridgeWaiters.indexOf(done);
          if (i >= 0) bridgeWaiters.splice(i, 1);
          resolve();
        }
        bridgeWaiters.push(done);
      });
      if (!isConnected()) {
        updateStatus('error', 'BitShares Workstation node not ready');
        throw new Error('BitShares Workstation desktop node is not connected');
      }
      return;
    }

    updateStatus('connecting', 'Connecting to node...');

    for (let attempt = 0; attempt < BITSHARES_NODES.length; attempt++) {
      const nodeUrl = BITSHARES_NODES[attempt];
      try {
        const ws = await new Promise((resolve, reject) => {
          const socket = new WebSocket(nodeUrl);
          const timeout = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 5000);
          socket.onopen = () => { clearTimeout(timeout); resolve(socket); };
          socket.onerror = () => { clearTimeout(timeout); reject(new Error('error')); };
        });

        currentWebSocket = ws;
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const req = pendingRequests.get(data.id);
            if (req) {
              pendingRequests.delete(data.id);
              if (data.error) req.reject(new Error(data.error.message || 'RPC Error'));
              else req.resolve(data.result);
            }
          } catch (e) { console.error('parse err', e); }
        };

        ws.onclose = () => {
          if (currentWebSocket === ws) currentWebSocket = null;
          for (const req of pendingRequests.values()) {
            req.reject(new Error('WebSocket connection closed'));
          }
          pendingRequests.clear();
          updateStatus('disconnected', 'Disconnected');
        };

        connectedHost = new URL(nodeUrl).host;
        updateStatus('connected', `Connected to ${connectedHost}`);
        return;
      } catch (err) {
        console.warn(`Failed node ${nodeUrl}`);
      }
    }

    updateStatus('error', 'Connection Failed');
    throw new Error('Could not connect to any BitShares node');
  }

  function disconnect() {
    if (isBridgeMode()) return;
    if (currentWebSocket) currentWebSocket.close();
    currentWebSocket = null;
  }

  function wssQuery(params) {
    if (isBridgeMode()) {
      // params is [api, method, methodParams]; api is 'database' or 'history'
      const [apiName, method, methodParams] = params;
      return window.B95.rpc(method, methodParams, { api: apiName === 'database' ? 0 : apiName });
    }
    return new Promise((resolve, reject) => {
      if (!isConnected()) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const id = messageId++;
      const query = JSON.stringify({ method: 'call', params, jsonrpc: '2.0', id });
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('RPC Timeout'));
      }, 20000);

      pendingRequests.set(id, {
        resolve: (val) => { clearTimeout(timeout); resolve(val); },
        reject: (err) => { clearTimeout(timeout); reject(err); }
      });
      currentWebSocket.send(query);
    });
  }

  // If embedded in BitShares Workstation, mirror the desktop's node status. One listener
  // for the page's lifetime; connectToNode() waits on it through bridgeWaiters.
  const BRIDGE_WAIT_MS = 30000;
  const bridgeWaiters = [];
  if (isBridgeMode()) {
    window.B95.onContext((ctx) => {
      const status = ctx.node?.status;
      if (status === 'online') {
        const host = ctx.node.url ? new URL(ctx.node.url).host : 'BitShares Workstation';
        connectedHost = host;
        updateStatus('connected', `Connected via B95 (${host})`);
        bridgeWaiters.slice().forEach(done => done());
      } else if (status === 'connecting') {
        updateStatus('connecting', 'Desktop node connecting...');
      } else if (status === 'offline') {
        updateStatus('disconnected', 'Desktop node offline');
      }
    });
  }

  /** One read-only call, connecting first if needed. api: 'database' or 'history'. */
  async function rpc(method, params, api = 'database') {
    if (!isConnected()) await connectToNode();
    return wssQuery([api, method, params]);
  }

  function clearDynamicCache() {
    for (const key of objectCache.keys()) {
      // Keep immutable asset metadata (1.3.x) while evicting mutable objects:
      // 1.21.x (credit offers), 1.19.x (liquidity pools), 2.3.x (dynamic asset data)
      if (!key.startsWith('1.3.')) {
        objectCache.delete(key);
      }
    }
  }

  async function rpcGetObjects(objectIds) {
    const ids = Array.isArray(objectIds) ? objectIds : [objectIds];
    const results = {};
    const missing = [];
    for (const id of ids) {
      if (objectCache.has(id)) results[id] = objectCache.get(id);
      else missing.push(id);
    }
    if (missing.length === 0) return results;

    const response = await wssQuery(['database', 'get_objects', [missing]]);
    if (response && Array.isArray(response)) {
      response.forEach((item, idx) => {
        if (item) {
          const objId = missing[idx];
          objectCache.set(objId, item);
          results[objId] = item;
        }
      });
    }
    return results;
  }

  // Pages through all deals for an offer. Throws on RPC failure so the caller
  // can flag the offer instead of silently showing it with zero deals.
  async function getCreditDealsForOffer(offerId) {
    const deals = [];
    let startId = null;
    while (true) {
      const params = startId ? [offerId, DEAL_PAGE_LIMIT, startId] : [offerId, DEAL_PAGE_LIMIT];
      const page = await wssQuery(['database', 'get_credit_deals_by_offer_id', params]);
      if (!Array.isArray(page) || page.length === 0) break;
      // start_id is inclusive, so drop the deal we already have
      const fresh = startId ? page.filter(d => d.id !== startId) : page;
      deals.push(...fresh);
      if (page.length < DEAL_PAGE_LIMIT || fresh.length === 0) break;
      startId = page[page.length - 1].id;
    }
    return deals;
  }

  function extractOfferInfo(offerObj, assetObjs) {
    if (!offerObj) return { rawAvail: 0, rawTotal: 0, rawMinDeal: 0, avail: 0, total: 0, minDeal: 0, precision: 5, enabled: false, feeRate: 0, maxDuration: 0 };

    const rawAvail = offerObj.current_balance !== undefined
      ? (typeof offerObj.current_balance === 'object' ? (offerObj.current_balance.amount || 0) : offerObj.current_balance)
      : (typeof offerObj.balance === 'object' ? (offerObj.balance.amount || 0) : (offerObj.balance || 0));

    const rawTotal = typeof offerObj.total_balance === 'object'
      ? (offerObj.total_balance.amount || 0)
      : (offerObj.total_balance || offerObj.balance || 0);

    const rawMinDeal = typeof offerObj.min_deal_amount === 'object'
      ? (offerObj.min_deal_amount.amount || 0)
      : (offerObj.min_deal_amount || 0);

    let precision = offerObj.precision;
    if (!precision && offerObj.asset_type && assetObjs && assetObjs[offerObj.asset_type]) {
      precision = assetObjs[offerObj.asset_type].precision;
    }
    if (!precision) {
      if (offerObj.asset_type === '1.3.5589' || offerObj.asset_type === '1.3.5902' || offerObj.id === '1.21.533' || offerObj.id === '1.21.542' || offerObj.asset_type === '1.3.6139' || offerObj.asset_type === '1.3.6620') {
        precision = 6;
      } else if (offerObj.asset_type === '1.3.5649') {
        precision = 7;
      } else if (offerObj.asset_type === '1.3.120') {
        precision = 4;
      } else {
        precision = 5;
      }
    }

    const numAvail = parseFloat(rawAvail) || 0;
    const numTotal = parseFloat(rawTotal) || 0;
    const numMinDeal = parseFloat(rawMinDeal) || 0;

    const avail = numAvail / Math.pow(10, precision);
    const total = numTotal / Math.pow(10, precision);
    const minDeal = numMinDeal / Math.pow(10, precision);

    return {
      rawAvail: numAvail,
      rawTotal: numTotal,
      rawMinDeal: numMinDeal,
      avail,
      total,
      minDeal,
      precision,
      feeRate: offerObj.fee_rate !== undefined ? (parseFloat(offerObj.fee_rate) || 0) : 0,
      maxDuration: offerObj.max_duration_seconds !== undefined ? (parseInt(offerObj.max_duration_seconds) || 0) : 0,
      enabled: offerObj.enabled !== false
    };
  }

  // LP Price Derivation
  function getLpUnitPrice(poolObj, quoteAssetId, assetCache) {
    if (!poolObj || !poolObj.balance_a || !poolObj.balance_b) return 0;
    const isQuoteA = poolObj.asset_a === quoteAssetId;
    const isQuoteB = poolObj.asset_b === quoteAssetId;

    if (!isQuoteA && !isQuoteB) return 0;

    const quoteId = isQuoteA ? poolObj.asset_a : poolObj.asset_b;
    const baseId = isQuoteA ? poolObj.asset_b : poolObj.asset_a;

    const quoteInfo = assetCache[quoteId] || { precision: 5 };
    const baseInfo = assetCache[baseId] || { precision: 5 };

    const rawQuote = isQuoteA ? parseFloat(poolObj.balance_a) : parseFloat(poolObj.balance_b);
    const rawBase = isQuoteA ? parseFloat(poolObj.balance_b) : parseFloat(poolObj.balance_a);

    const humanQuote = rawQuote / Math.pow(10, quoteInfo.precision);
    const humanBase = rawBase / Math.pow(10, baseInfo.precision);

    if (humanBase === 0) return 0;
    return humanQuote / humanBase;
  }

  function getTwentixUsdPrice(poolMap, assetCache) {
    const pool248 = poolMap['1.19.248'];
    if (pool248) {
      const directPrice = getLpUnitPrice(pool248, '1.3.5902', assetCache);
      if (directPrice > 0) return directPrice;
    }

    const pool0 = poolMap['1.19.0'];
    const pool48 = poolMap['1.19.48'];
    if (pool0 && pool48) {
      const btsUsd = getLpUnitPrice(pool48, '1.3.5589', assetCache);
      const isBtsA = pool0.asset_a === '1.3.0';
      const isBtsB = pool0.asset_b === '1.3.0';
      if ((isBtsA || isBtsB) && btsUsd > 0) {
        const rawBts = isBtsA ? parseFloat(pool0.balance_a) : parseFloat(pool0.balance_b);
        const rawTwentix = isBtsA ? parseFloat(pool0.balance_b) : parseFloat(pool0.balance_a);
        if (rawTwentix > 0) {
          const btsPrec = assetCache['1.3.0']?.precision ?? 5;
          const twentixPrec = assetCache['1.3.3291']?.precision ?? 5;
          const btsPerTwentix = (rawBts / Math.pow(10, btsPrec)) / (rawTwentix / Math.pow(10, twentixPrec));
          return btsPerTwentix * btsUsd;
        }
      }
    }
    return 0;
  }

  /**
   * Universal Asset & LP Token USD Valuation Engine
   */
  function getAssetUsdPrice(assetId, poolMap, assetCache, dynCache, visited = new Set()) {
    if (!assetId || visited.has(assetId)) return 0;
    visited.add(assetId);

    // 1. USD Stablecoins (USDT, USDC, HONEST.USD, BITUSD)
    if (assetId === '1.3.5589' || assetId === '1.3.5902' || assetId === '1.3.5649' || assetId === '1.3.121') {
      return 1.0;
    }

    // 2. Native BTS (1.3.0) via BTS/USDT pool 1.19.48
    if (assetId === '1.3.0') {
      const pool48 = poolMap['1.19.48'];
      if (pool48) {
        const btsUsd = getLpUnitPrice(pool48, '1.3.5589', assetCache);
        if (btsUsd > 0) return btsUsd;
      }
    }

    // 3. TWENTIX (1.3.3291)
    if (assetId === '1.3.3291') {
      const twentixPrice = getTwentixUsdPrice(poolMap, assetCache);
      if (twentixPrice > 0) return twentixPrice;
    }

    const meta = assetCache[assetId];

    // 4. LP Token Intrinsic Valuation (via for_liquidity_pool)
    const lpPoolId = meta?.for_liquidity_pool;
    if (lpPoolId && poolMap[lpPoolId]) {
      const pool = poolMap[lpPoolId];
      const prec = meta.precision !== undefined ? meta.precision : 5;

      let lpSupply = 0;
      if (meta.dynamic_asset_data_id && dynCache && dynCache[meta.dynamic_asset_data_id]) {
        const rawSupply = parseFloat(dynCache[meta.dynamic_asset_data_id].current_supply || 0);
        lpSupply = rawSupply / Math.pow(10, prec);
      }

      // No hardcoded supply fallbacks: without live supply data the LP token is
      // reported as unpriced rather than valued from a stale snapshot.
      if (lpSupply > 0) {
        const assetA = pool.asset_a;
        const assetB = pool.asset_b;
        const precA = assetCache[assetA]?.precision !== undefined ? assetCache[assetA].precision : 5;
        const precB = assetCache[assetB]?.precision !== undefined ? assetCache[assetB].precision : 5;
        const natA = (parseFloat(pool.balance_a) || 0) / Math.pow(10, precA);
        const natB = (parseFloat(pool.balance_b) || 0) / Math.pow(10, precB);

        const priceA = getAssetUsdPrice(assetA, poolMap, assetCache, dynCache, new Set(visited));
        const priceB = getAssetUsdPrice(assetB, poolMap, assetCache, dynCache, new Set(visited));

        let poolTotalUsd = 0;
        if (priceA > 0 && priceB > 0) {
          poolTotalUsd = (natA * priceA) + (natB * priceB);
        } else if (priceA > 0) {
          poolTotalUsd = natA * priceA * 2;
        } else if (priceB > 0) {
          poolTotalUsd = natB * priceB * 2;
        }

        if (poolTotalUsd > 0) {
          return poolTotalUsd / lpSupply;
        }
      }
    }

    // 5. Liquid Asset Reference Pools & Secondary Pool Lookups
    for (const pool of Object.values(poolMap)) {
      if (!pool || !pool.balance_a || !pool.balance_b) continue;
      if (pool.asset_a === assetId || pool.asset_b === assetId) {
        const quoteId = pool.asset_a === assetId ? pool.asset_b : pool.asset_a;
        if (quoteId === '1.3.5589' || quoteId === '1.3.5902') {
          const directPrice = getLpUnitPrice(pool, quoteId, assetCache);
          if (directPrice > 0) return directPrice;
        } else if (quoteId === '1.3.0') {
          const btsUsd = getAssetUsdPrice('1.3.0', poolMap, assetCache, dynCache, new Set(visited));
          const priceInBts = getLpUnitPrice(pool, quoteId, assetCache);
          if (priceInBts > 0 && btsUsd > 0) {
            return priceInBts * btsUsd;
          }
        } else if (quoteId === '1.3.3291') {
          const twentixUsd = getAssetUsdPrice('1.3.3291', poolMap, assetCache, dynCache, new Set(visited));
          const priceInTwentix = getLpUnitPrice(pool, quoteId, assetCache);
          if (priceInTwentix > 0 && twentixUsd > 0) {
            return priceInTwentix * twentixUsd;
          }
        }
      }
    }

    return 0;
  }

  function calculateOfferUsdValuation(cfg, offerObj, poolMap, assetCache, dynCache) {
    if (!offerObj) return null;
    const info = extractOfferInfo(offerObj, assetCache);

    let unitPrice = 0;
    let source = '';

    if (cfg.pricing === 'stable') {
      unitPrice = 1.0;
      source = 'stable USD (1:1)';
    } else if (cfg.pricing === 'direct' && cfg.poolId && poolMap[cfg.poolId]) {
      const pool = poolMap[cfg.poolId];
      unitPrice = getLpUnitPrice(pool, cfg.quoteAssetId, assetCache);
      source = `LP ${cfg.poolId}`;
    } else if (cfg.pricing === 'chained' && cfg.poolId && cfg.chainedPoolId && poolMap[cfg.poolId] && poolMap[cfg.chainedPoolId]) {
      const pool1 = poolMap[cfg.poolId];
      const pool2 = poolMap[cfg.chainedPoolId];
      const price1 = getLpUnitPrice(pool1, cfg.quoteAssetId, assetCache);
      const price2 = getLpUnitPrice(pool2, cfg.chainedQuoteAssetId, assetCache);
      unitPrice = price1 * price2;
      source = `LP ${cfg.poolId} → ${cfg.chainedPoolId}`;
    }

    // Fallback to recursive universal valuation if price was zero or missing
    if (unitPrice <= 0 && offerObj.asset_type) {
      unitPrice = getAssetUsdPrice(offerObj.asset_type, poolMap, assetCache, dynCache);
      if (unitPrice > 0) source = 'universal valuation';
    }

    const taken = Math.max(0, info.total - info.avail);
    const usdBalance = info.avail * unitPrice;
    const usdTotal = info.total * unitPrice;
    const usdTaken = Math.max(0, usdTotal - usdBalance);
    const utilizationPct = info.total > 0 ? (taken / info.total) * 100 : 0;

    return {
      unitPrice,
      usdBalance,
      usdTotal,
      usdTaken,
      avail: info.avail,
      total: info.total,
      taken,
      utilizationPct,
      minDeal: info.minDeal,
      precision: info.precision,
      feeRate: info.feeRate,
      maxDuration: info.maxDuration,
      enabled: info.enabled,
      source: source || 'unpriced'
    };
  }

  function dealCollateralAsset(d) {
    return d.collateral_asset ?? d.collateral_for_deposit?.asset_id ?? d.collateral?.asset_id;
  }

  function dealCollateralAmount(d) {
    return parseFloat(String(d.collateral_amount ?? d.collateral_for_deposit?.amount ?? d.collateral?.amount ?? '0')) || 0;
  }

  /**
   * Fetches fresh chain state and values every monitored offer and its deals.
   * Returns { at, node, rows, collateralBreakdown, activeOffersCount, totals }
   * where totals.credit is the Total USD Credit shown on the dashboard.
   * Rows carry { cfg, offerObj, evalRes, deals, dealsFailed, stats }.
   * includeExternal adds EXTERNAL_OFFERS; those totals aren't published, so
   * listeners keep seeing the monitored-only figure.
   */
  async function fetchCreditSnapshot({ includeExternal = false } = {}) {
    const offers = includeExternal ? [...MONITORED_OFFERS, ...EXTERNAL_OFFERS] : MONITORED_OFFERS;
    if (!isConnected()) {
      await connectToNode();
    }

    // Invalidate dynamic on-chain objects so fresh balances/pools are retrieved
    clearDynamicCache();

    // 1. Fetch Monitored Offers & Initial Reference Pools
    const offerIds = offers.map(o => o.offerId);
    const rawObjects = await rpcGetObjects([...offerIds, ...REFERENCE_POOL_IDS]);
    let poolsMap = Object.assign({}, rawObjects);

    // 2. Fetch Active Deals for monitored offers (all pages)
    const allDeals = [];
    const dealFetchErrors = new Set();
    const dealResults = await Promise.all(offerIds.map(oId =>
      getCreditDealsForOffer(oId).catch(err => {
        console.warn(`Failed to fetch deals for ${oId}:`, err);
        dealFetchErrors.add(oId);
        return [];
      })
    ));
    dealResults.forEach((deals, idx) => {
      const offerId = offerIds[idx];
      deals.forEach(d => allDeals.push({ ...d, offerId }));
    });

    // 3. Gather unique collateral assets from deals
    const collateralAssetIds = new Set();
    allDeals.forEach(d => {
      const assetId = dealCollateralAsset(d);
      if (assetId) collateralAssetIds.add(assetId);
    });

    // 4. Fetch all required Asset Objects
    const baseAssetIds = new Set([...REFERENCE_ASSET_IDS, ...collateralAssetIds]);
    for (const o of Object.values(rawObjects)) {
      if (o && o.asset_a) baseAssetIds.add(o.asset_a);
      if (o && o.asset_b) baseAssetIds.add(o.asset_b);
      if (o && o.asset_type) baseAssetIds.add(o.asset_type);
      if (o && o.share_asset) baseAssetIds.add(o.share_asset);
    }
    let assetObjs = await rpcGetObjects(Array.from(baseAssetIds));

    // 5. Dynamically Discover LP backing pools & dynamic asset data IDs
    const extraPoolIds = new Set();
    const dynIds = new Set();

    for (const a of Object.values(assetObjs)) {
      if (a && a.for_liquidity_pool) extraPoolIds.add(a.for_liquidity_pool);
      if (a && a.dynamic_asset_data_id) dynIds.add(a.dynamic_asset_data_id);
    }

    const missingPoolIds = Array.from(extraPoolIds).filter(id => !poolsMap[id]);
    if (missingPoolIds.length > 0) {
      const extraPoolObjs = await rpcGetObjects(missingPoolIds);
      poolsMap = Object.assign({}, poolsMap, extraPoolObjs);
      for (const p of Object.values(extraPoolObjs)) {
        if (p && p.asset_a) baseAssetIds.add(p.asset_a);
        if (p && p.asset_b) baseAssetIds.add(p.asset_b);
      }
    }

    // Fetch any missing underlying assets for newly discovered pools
    const missingAssetIds = Array.from(baseAssetIds).filter(id => !assetObjs[id]);
    if (missingAssetIds.length > 0) {
      const extraAssetObjs = await rpcGetObjects(missingAssetIds);
      assetObjs = Object.assign({}, assetObjs, extraAssetObjs);
      for (const a of Object.values(extraAssetObjs)) {
        if (a && a.dynamic_asset_data_id) dynIds.add(a.dynamic_asset_data_id);
      }
    }

    // Fetch dynamic asset data IDs (for supply calculation)
    let dynDataMap = {};
    if (dynIds.size > 0) {
      dynDataMap = await rpcGetObjects(Array.from(dynIds));
    }

    const priceCache = new Map();
    const priceOf = (assetId) => {
      if (!priceCache.has(assetId)) {
        priceCache.set(assetId, getAssetUsdPrice(assetId, poolsMap, assetObjs, dynDataMap));
      }
      return priceCache.get(assetId);
    };

    // 6. Evaluate every monitored offer (including missing / unpriced ones)
    const offerRows = offers.map(cfg => {
      const offerObj = rawObjects[cfg.offerId] || null;
      const evalRes = offerObj ? calculateOfferUsdValuation(cfg, offerObj, poolsMap, assetObjs, dynDataMap) : null;
      return { cfg, offerObj, evalRes, deals: [], dealsFailed: dealFetchErrors.has(cfg.offerId) };
    });
    const rowsById = Object.fromEntries(offerRows.map(r => [r.cfg.offerId, r]));
    allDeals.forEach(d => rowsById[d.offerId]?.deals.push(d));

    let totalUsdCredit = 0;
    let totalAvailableUsdCredit = 0;
    let totalTakenUsdCredit = 0;
    let activeOffersCount = 0;

    offerRows.forEach(({ evalRes }) => {
      if (!evalRes) return;
      if (evalRes.enabled && (evalRes.total > 0 || evalRes.avail > 0)) activeOffersCount++;
      totalUsdCredit += evalRes.usdTotal;
      totalAvailableUsdCredit += evalRes.usdBalance;
      totalTakenUsdCredit += evalRes.usdTaken;
    });

    // 7. Deal-level collateral ratios (collateral USD / debt USD), per offer and global.
    // Deals whose debt or collateral can't be priced are excluded and counted.
    const collateralGroupMap = {};
    let dealDebtUsd = 0;
    let dealCollUsd = 0;
    let excludedDeals = 0;

    offerRows.forEach(row => {
      const stats = { dealCount: row.deals.length, debtUsd: 0, collUsd: 0, pricedDeals: 0, unpricedDeals: 0, belowFloor: 0, cr: null };
      const debtPrice = row.evalRes?.unitPrice || 0;

      row.deals.forEach(d => {
        const collId = dealCollateralAsset(d);
        const rawColl = dealCollateralAmount(d);
        if (collId) {
          if (!collateralGroupMap[collId]) collateralGroupMap[collId] = { assetId: collId, rawAmount: 0, dealCount: 0 };
          collateralGroupMap[collId].rawAmount += rawColl;
          collateralGroupMap[collId].dealCount += 1;
        }

        const debtAssetId = d.debt_asset || row.offerObj?.asset_type;
        const debtPrec = assetObjs[debtAssetId]?.precision ?? row.evalRes?.precision ?? 5;
        const debt = (parseFloat(d.debt_amount) || 0) / Math.pow(10, debtPrec);
        const collPrice = collId ? priceOf(collId) : 0;
        const coll = rawColl / Math.pow(10, assetObjs[collId]?.precision ?? 5);

        if (debtPrice > 0 && collPrice > 0 && debt > 0) {
          const dUsd = debt * debtPrice;
          const cUsd = coll * collPrice;
          stats.debtUsd += dUsd;
          stats.collUsd += cUsd;
          stats.pricedDeals++;
          if ((cUsd / dUsd) * 100 < CR_FLOOR_PCT) stats.belowFloor++;
        } else {
          stats.unpricedDeals++;
        }
      });

      stats.cr = stats.debtUsd > 0 ? (stats.collUsd / stats.debtUsd) * 100 : null;
      row.stats = stats;
      dealDebtUsd += stats.debtUsd;
      dealCollUsd += stats.collUsd;
      excludedDeals += stats.unpricedDeals;
    });

    // 8. Collateral composition by asset
    let totalCollateralUsd = 0;
    const collateralBreakdown = [];

    for (const [assetId, group] of Object.entries(collateralGroupMap)) {
      const meta = assetObjs[assetId] || { symbol: assetId, precision: 5 };
      const humanAmount = group.rawAmount / Math.pow(10, meta.precision);
      const unitPrice = priceOf(assetId);
      const usdVal = humanAmount * unitPrice;
      totalCollateralUsd += usdVal;

      collateralBreakdown.push({
        assetId,
        symbol: scrubAssetSymbol(meta.symbol),
        humanAmount,
        unitPrice,
        usdVal,
        dealCount: group.dealCount
      });
    }

    collateralBreakdown.sort((a, b) => b.usdVal - a.usdVal);

    const takenPct = totalUsdCredit > 0 ? (totalTakenUsdCredit / totalUsdCredit) * 100 : 0;
    const snapshot = {
      at: new Date(),
      node: connectedHost,
      rows: offerRows,
      collateralBreakdown,
      activeOffersCount,
      totals: {
        credit: totalUsdCredit,
        taken: totalTakenUsdCredit,
        avail: totalAvailableUsdCredit,
        takenPct,
        collateral: totalCollateralUsd,
        cr: dealDebtUsd > 0 ? (dealCollUsd / dealDebtUsd) * 100 : null,
        deals: allDeals.length,
        excludedDeals
      }
    };
    if (!includeExternal) publishTotals(snapshot);
    return snapshot;
  }

  // ---- Cross-page sharing (browser only) ----
  // Every successful fetch is cached in localStorage and broadcast to other open
  // CreditFlow tabs, so a page can paint the last known Total USD Credit instantly
  // and pick up fresher values computed by a sibling tab.

  const TOTALS_STORAGE_KEY = 'creditflow:totals:v1';
  const CHANNEL_NAME = 'creditflow';
  let channel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined' && typeof window !== 'undefined') channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) { channel = null; }

  function unpricedSymbols(snapshot) {
    return snapshot.rows.filter(r => r.evalRes && r.evalRes.unitPrice <= 0).map(r => r.cfg.symbol);
  }

  function totalsRecord(snapshot) {
    const t = snapshot.totals;
    return {
      credit: t.credit,
      taken: t.taken,
      avail: t.avail,
      at: snapshot.at.toISOString(),
      node: snapshot.node,
      unpriced: unpricedSymbols(snapshot),
      missing: snapshot.rows.filter(r => !r.offerObj).map(r => r.cfg.symbol)
    };
  }

  function publishTotals(snapshot) {
    if (typeof window === 'undefined') return;
    const rec = totalsRecord(snapshot);
    try { localStorage.setItem(TOTALS_STORAGE_KEY, JSON.stringify(rec)); } catch (e) { /* storage unavailable */ }
    try { channel && channel.postMessage({ type: 'totals', totals: rec }); } catch (e) { /* ignore */ }
  }

  function readCachedTotals() {
    try {
      const rec = JSON.parse(localStorage.getItem(TOTALS_STORAGE_KEY) || 'null');
      return rec && Number.isFinite(rec.credit) ? rec : null;
    } catch (e) {
      return null;
    }
  }

  function onTotals(fn) {
    if (!channel) return;
    channel.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'totals' && Number.isFinite(ev.data.totals?.credit)) fn(ev.data.totals);
    });
  }

  const api = {
    BITSHARES_NODES,
    BOB_GEARS,
    MONITORED_OFFERS,
    EXTERNAL_OFFERS,
    CR_FLOOR_PCT,
    scrubAssetSymbol,
    onStatus,
    connectToNode,
    disconnect,
    isConnected,
    getConnectedHost: () => connectedHost,
    wssQuery,
    rpc,
    rpcGetObjects,
    getAssetUsdPrice,
    calculateOfferUsdValuation,
    dealCollateralAsset,
    dealCollateralAmount,
    fetchCreditSnapshot,
    totalsRecord,
    readCachedTotals,
    onTotals
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CreditFlowEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
