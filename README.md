# BitShares95

A browser desktop for BitShares DEX tools. Each tool is a small, self-contained HTML app
that opens in its own window on the desktop.

**Live:** https://bitshares95.vercel.app

## Apps

| App | What it does |
|---|---|
| microDEX | Retro order book terminal |
| Pools Tracker | Liquidity pool TVL and swaps, with Beet wallet links |
| Pool Stats Lite | BTC pool depth, LP share values, swap and deposit builder |
| LP Router | 1- to 3-hop AMM routes across pools, built as one transaction |
| Gateway Board | Pool price boards (XRP·USDT, XRP·BTC, BTC·XAUT) with a buy / sell terminal |
| CreditFlow | Credit offer TVL and collateral dashboard |
| ioBanker Gateway | IOB.XRP / IOB.XLM deposit addresses with your memo and balances |
| ioBanker LP PPS | Fee yield per LP share for the ioBanker pools |
| Transfer | Asset transfer builder |

## How it works

- **One login, one node.** The desktop connects to a public BitShares node and holds the
  account name you log in with. Every app shares both. You type an account name, never a key.
- **Nothing is signed here.** Apps build transactions as BeetVault requests. Download the
  request as a `.json` file and upload it in BeetVault, or open it as a `rawbeetvault://`
  deeplink. BeetVault shows the transaction and signs it.
- **Static files only.** There is no backend. Your browser talks to BitShares nodes directly
  over `wss://`. Logins and window layouts are saved in your own browser.

## Run it yourself

Serve the folder with any static web server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. To host your own copy, fork this repository and import the
fork in Vercel with the **Other** framework preset and no build command.

## Add your own app

Have a workflow you run by hand? Turn it into an app. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the app format, the rules apps follow, and how an app gets onto the main site.

## License

MIT, see [LICENSE](LICENSE). The bundled Inter and JetBrains Mono fonts in `shared/fonts/`
are under the SIL Open Font License 1.1.

This repository is generated from the maintainer's source and republished with each release.
