// BitShares95 app bridge.
// Include from an app page: <script src="../shared/b95-bridge.js"></script>
//
// Inside the desktop, apps share its BitShares node connection and logged-in
// account and can raise desktop notifications. Opened on their own (Pop-out),
// the same calls still work: rpc() opens its own read-only node connection,
// notify() shows the message in the page's corner, and onContext() reports no account.
(function () {
  const embedded = window.parent !== window;
  const contextListeners = [];
  const pendingRpc = new Map();
  let rpcSeq = 0;
  let shown = true; // false while the desktop has this app's window minimized
  let context = { account: null, node: { status: embedded ? 'connecting' : 'standalone' }, walletScheme: null };

  function send(msg) {
    if (embedded) window.parent.postMessage({ b95: true, ...msg }, '*');
  }

  function emitContext() {
    contextListeners.forEach(cb => { try { cb(context); } catch (err) { console.error(err); } });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || e.data.b95 !== true) return;
    const msg = e.data;
    if (msg.type === 'context') {
      context = { account: msg.account || null, node: msg.node || {}, walletScheme: msg.walletScheme || null };
      emitContext();
    } else if (msg.type === 'shown') {
      shown = msg.shown !== false;
    } else if (msg.type === 'rpc-result') {
      const p = pendingRpc.get(msg.id);
      if (!p) return;
      pendingRpc.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
    }
  });

  // New pending call: its id and the promise the reply (or a 15 s timeout) settles
  function pendingCall() {
    const id = `r${++rpcSeq}`;
    const promise = new Promise((resolve, reject) => {
      pendingRpc.set(id, { resolve, reject });
      setTimeout(() => {
        if (pendingRpc.has(id)) { pendingRpc.delete(id); reject(new Error('Request timed out')); }
      }, 15000);
    });
    return { id, promise };
  }

  // --- Standalone fallback: a private read-only node connection ---
  // BitShares mainnet: a node answering with another chain id is skipped (the desktop checks the same)
  const CHAIN_ID = '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8';
  // Public BitShares nodes, tried in order. The desktop uses this same list.
  const NODE_URLS = Object.freeze([
    'wss://node.xbts.io/ws',
    'wss://api.bts.mobi/ws',
    'wss://dex.iobanker.com/ws',
    'wss://public.xbts.io/ws',
    'wss://cloud.xbts.io/ws'
  ]);
  let ownSocket = null;
  let ownConnecting = null;

  function ownCall(ws, api, method, params) {
    const { id, promise } = pendingCall();
    ws.send(JSON.stringify({ id, method: 'call', params: [api, method, params] }));
    return promise;
  }

  function ownConnect() {
    if (ownSocket && ownSocket.readyState === WebSocket.OPEN) return Promise.resolve(ownSocket);
    if (ownConnecting) return ownConnecting;
    ownConnecting = (async () => {
      for (const url of NODE_URLS) {
        let ws = null;
        try {
          ws = await new Promise((resolve, reject) => {
            const sock = new WebSocket(url);
            const timer = setTimeout(() => { sock.close(); reject(new Error('Timed out')); }, 8000);
            sock.onopen = () => { clearTimeout(timer); resolve(sock); };
            sock.onerror = () => { clearTimeout(timer); reject(new Error('Connection failed')); };
          });
          ws.onmessage = (m) => {
            let data;
            try { data = JSON.parse(m.data); } catch (_) { return; }
            const p = pendingRpc.get(data.id);
            if (!p) return;
            pendingRpc.delete(data.id);
            if (data.error) p.reject(new Error(data.error.message || 'RPC error')); else p.resolve(data.result);
          };
          ws.onclose = () => {
            if (ownSocket === ws) {
              ownSocket = null;
              for (const p of pendingRpc.values()) p.reject(new Error('WebSocket connection closed'));
              pendingRpc.clear();
              context = { ...context, node: { status: 'offline', url: null } };
              emitContext();
            }
          };
          if (await ownCall(ws, 0, 'get_chain_id', []) !== CHAIN_ID) throw new Error('Not BitShares mainnet');
          ownSocket = ws;
          context = { ...context, node: { status: 'online', url } };
          emitContext();
          return ws;
        } catch (_) {
          if (ws) ws.close(); // try the next node
        }
      }
      context = { ...context, node: { status: 'offline', url: null } };
      emitContext();
      throw new Error('No BitShares node reachable');
    })().finally(() => { ownConnecting = null; });
    return ownConnecting;
  }

  // Node APIs apps may call: 0 is the database API, 'history' covers account and pool history
  const APIS = [0, 'database', 'history'];

  function rpc(method, params, { api = 0 } = {}) {
    if (!APIS.includes(api)) return Promise.reject(new Error(`API not allowed: ${api}`));
    if (!embedded) return ownConnect().then(ws => ownCall(ws, api, method, params));
    const { id, promise } = pendingCall();
    send({ type: 'rpc', id, api, method, params });
    return promise;
  }

  // Standalone stand-in for the desktop's notifications: one small message in the page's corner
  let toastTimer = null;
  function toast(title, msg) {
    let box = document.getElementById('b95-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'b95-toast';
      box.setAttribute('role', 'status');
      box.title = 'Click to dismiss';
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 14px;' +
        'border-radius:8px;background:#2e3440;color:#eceff4;border:1px solid #4c566a;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
        'font:13px/1.4 var(--font-ui, sans-serif);cursor:pointer';
      box.addEventListener('click', () => box.remove());
    }
    const heading = document.createElement('strong');
    heading.style.display = 'block';
    heading.textContent = title;
    box.replaceChildren(heading, document.createTextNode(msg));
    (document.body || document.documentElement).appendChild(box);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.remove(), Math.min(12000, 4000 + 40 * String(msg).length));
  }

  // False while nobody can see the page: the browser tab is in the background, or the desktop has the
  // window minimized (it tells the app; a hidden frame can't see that for itself). Polling loops check
  // this before fetching.
  function visible() {
    return !document.hidden && shown;
  }

  // Account object for a name or 1.2.x id; rejects when it doesn't exist
  async function resolveAccount(nameOrId) {
    const key = String(nameOrId || '').trim().toLowerCase();
    if (!key) throw new Error('Enter an account name or ID');
    const acc = /^1\.2\.\d+$/.test(key)
      ? (await rpc('get_objects', [[key]]))[0]
      : await rpc('get_account_by_name', [key]);
    if (!acc || !acc.id) throw new Error(`Account "${key}" not found on BitShares`);
    return acc;
  }

  // Follows a wallet deeplink (rawbeetvault:// etc.) from this page
  function followLink(url) {
    const a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  window.B95 = {
    embedded,
    NODE_URLS,
    CHAIN_ID,
    visible,
    followLink,
    get context() { return context; },
    // cb(context) now and on every change: { account: {name, id} | null, node: {status, url, ...} }
    onContext(cb) { contextListeners.push(cb); cb(context); },
    // rpc(method, params, { api }): read-only node call; api defaults to the database API
    rpc,
    resolveAccount,
    // A desktop notification; standalone, a message in the page's corner
    notify(title, msg) { if (embedded) send({ type: 'notify', title, msg }); else toast(String(title), String(msg)); },
    setTitle(title) { send({ type: 'title', title }); },
    openApp(id) { send({ type: 'open', app: id }); },
    login() { send({ type: 'login' }); },
    openDeeplink(url) { if (embedded) send({ type: 'deeplink', url }); else followLink(url); },
  };

  send({ type: 'hello' });
})();
