# Card NFT 2 Binder — v2 (Multi-Collection + Trade Matchmaker)

A fan-made browser for collections by evil biscuit — built on Solana. One server hosts multiple collection binders:

- **Card NFT 2** — `/` — browse, filter by traits, holo effects, wallet view, marketplace listings
- **Poncho Drifella** — `/poncho` — all of the above, plus an **unminted view** (cards still sealed inside packs, with their pre-published art) and a **trade matchmaker**

> **v1 (browse only, single collection):** [isdoomcoding/card-nft-2-binder](https://github.com/isdoomcoding/card-nft-2-binder)

---

## Stack

- Single-file frontends: `card-nft-2-binder.html`, `poncho-binder.html` (HTML + CSS + JS)
- Compiled Tailwind: `tailwind.css` — rebuild with `npm run css:build` after editing either HTML file
- Node.js server: `minimal-server.js` — serves the HTML, proxies Helius DAS calls, caches each collection, aggregates Magic Eden listings (`listingAggMode=true` so escrow-less M2 listings are included)
- Trade module: `trade.js` — SIWS auth, per-collection intent stores, two-way match engine (zero runtime deps)
- Snapshot tool: `node snapshot-collection.js [card_nft_2|poncho]` — static fallback when no Helius key

Collections are defined in the `COLLECTIONS` map at the top of `minimal-server.js` — adding another one is a new entry there plus a forked binder HTML.

API routes are namespaced per collection (`/api/<slug>/collection`, `/wallet`, `/listings`, `/unminted`, `/trade/*`); the original un-namespaced v1 routes still work as aliases for `card_nft_2`.

> Note: the server caches static files (incl. the HTML) in memory for the life of the process — restart it to pick up frontend edits.

---

## Setup

### 1. Get a Helius API key

Sign up at [helius.dev](https://helius.dev) and create an API key with DAS access.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
HELIUS_RPC_KEY=your_helius_api_key_here
PORT=8788
WEBHOOK_SECRET=optional_shared_secret_for_the_helius_webhook
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run

```bash
node minimal-server.js
```

Open `http://localhost:8788` (Card NFT 2) or `http://localhost:8788/poncho` (Poncho Drifella). Use the collection switcher in the top-left of either page to jump between them.

---

## Trade feature (Poncho Drifella)

Wallets connect via Phantom or Solflare, sign a message to prove ownership, then declare:
- **Haves** — cards from their wallet they're willing to trade
- **Wants** — specific cards or trait-based wants (e.g. "any Holo")

The server runs two-way matching: if your haves satisfy someone's wants and their haves satisfy yours, it's a match. Both wallets and the candidate cards are revealed — settlement happens via any swap tool the parties choose (Cofre, Token Entangler, etc.).

Sessions are shared across collections; trade profiles are stored per collection (`data/trade-intents*.json`).

---

## Unminted view (Poncho Drifella)

The 207-card set's metadata and art are pre-published, so cards that have never been minted on-chain (still sealed inside unopened packs) can be previewed. The server computes the unminted set from Helius data — every `card N` / `receipt · card N` ever seen on-chain (including burnt) counts as revealed; the rest are "still in a pack". Note that pack numbers and card numbers are independent, and a pack redeemed physically without opening burns without ever revealing its card — which is why sealed packs and unminted cards are different counts.

---

## Production deployment

The server is production-ready: gzip + ETag static caching, stale-while-revalidate collection caching, and a Helius webhook (`/helius-webhook`, gated by `WEBHOOK_SECRET`) for realtime new-mint pickup.

Recommended setup: **pm2** + reverse proxy / tunnel (nginx, cloudflared, or Tailscale Funnel).

```bash
pm2 start minimal-server.js --name card-binder
```

---

## License

Fan-made project by [@isdoomcoding](https://github.com/isdoomcoding) / [@DoomOperator](https://x.com/DoomOperator), released as copyleft FOSS under the [AGPL-3.0 license](LICENSE).

Card NFT 2 and Poncho Drifella artwork is by [evil biscuit](https://x.com/bis__cut). This project is not affiliated with or endorsed by evil biscuit.
