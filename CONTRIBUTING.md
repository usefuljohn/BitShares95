# Contributing to BitShares95

The best way to contribute is to turn a workflow you know well into an app that other
people can drop into the desktop. There are two ways to share it:

1. **Fork and run your own copy.** Add your app to your fork and deploy it to your own
   Vercel project. Nothing needs approval.
2. **Propose it for the main site.** Open a pull request that adds your app, or open an
   issue that links to your fork.

## The app format

An app is one folder with an `index.html`, plus any scripts it needs:

```
your-app/
  index.html
  your-engine.js        (optional)
```

Load the two shared helpers:

```html
<script src="../shared/b95-bridge.js"></script>
<script src="../shared/beetvault.js"></script>
```

### Bridge (`B95`)

| Call | What it does |
|---|---|
| `B95.onContext(cb)` | Calls `cb(ctx)` now and whenever it changes. `ctx.account` is `{ name, id }` or `null`; `ctx.node` has the connection status. |
| `B95.rpc(method, params, { api })` | A read-only node call. The API defaults to the database API. |
| `B95.notify(title, msg)` | A desktop notification. |
| `B95.openApp(id)` | Opens another app, for example `B95.openApp('lprouter')`. |
| `B95.login()` | Opens the desktop's login window. |

Your app also works when opened in its own tab. `B95.rpc` then opens its own node
connection and `ctx.account` is `null`, so offer an account field as a fallback.

### Transactions (`BeetVault`)

```js
// expiration: BeetVault.expirationFrom(chainTime), with chainTime from the node's head block
const request = BeetVault.buildRequest([op], { appName: 'Your App', expiration });
BeetVault.downloadRequest(request, 'your-app.json');   // file for BeetVault's Local JSON page
BeetVault.launchDeeplink(request);                      // or a rawbeetvault:// deeplink
```

`asset-transfer/` is the smallest complete example: one page, one engine file, the
bridge and a BeetVault request.

## Registering the app on the desktop

Add an entry to `APPS` in `index.html`:

```js
{ id: 'myapp', title: 'My App', windowTitle: 'My App - What it does', emoji: '🧭',
  icon: ICONS.generic, src: 'my-app/index.html', size: [900, 620], menu: 'pools',
  status: ['my-app/index.html', 'Short status line'], public: true },
```

- `id` must be unique.
- `menu` is one of `pools`, `credit`, `portfolio`, `builders` or `links`.
- For your own icon, add a 34×34 SVG to `ICONS` and use `icon: ICONS.myapp`.

## Rules apps follow

The site sends a strict security policy, and every app runs on the same origin as the
desktop. Apps on the main site must follow these rules:

- **No outside scripts or stylesheets.** Ship everything in your folder.
- **No `https:` requests by default.** Only `wss:` node connections are allowed. If your app
  needs an API, say which host and why in your pull request.
- **Read-only node calls.** Through the desktop, `B95.rpc` allows only `get_`, `lookup_` and
  `list_` methods on the database and history APIs.
- **Transactions go through BeetVault only.** Never ask for a key, password or seed phrase.
- **Talk to the desktop through `B95` only.** Don't reach into `window.parent`, `top` or other
  apps' windows.
- **Prefix storage keys with your app's id.** All apps share one `localStorage`. Don't read or
  write `b95-*` keys or another app's keys.
- **Readable code.** No `eval`, `new Function` or minified or encoded code.
- **No personal details.** Leave email addresses out of your files. The publishing step
  rejects any file that contains one.
- **Put usage notes in the app itself.** Markdown files inside app folders aren't kept when
  the site is republished.

## How a pull request lands

1. The maintainer reads all of your app's code, including every operation it builds.
2. Your pull request is merged, so GitHub lists you as a contributor.
3. The maintainer adds your app to the upstream source and republishes this repository. Your
   `index.html` entry may be adjusted along the way. The republish commit credits you as
   co-author.

## Keeping your fork up to date

Add this repository (the one you forked from) as `upstream`, then pull from it:

```bash
git remote add upstream <this repository's clone URL>
git pull upstream main
```

If both you and upstream added `APPS` entries, `index.html` will conflict. Keep both entries.

## Reporting a security problem

If you find a way for an app or the desktop to change a transaction, leak an account or
bypass the security policy, report it privately through the repository's **Security** tab
rather than in a public issue.
