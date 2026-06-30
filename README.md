# Card NFT 2 Binder — v2 (Trade Matchmaker)

A fan-made browser for the [Card NFT 2](https://x.com/bis__cut) collection by evil biscuit, extended with a **trade matchmaker** — declare what you have and what you want, get matched with wallets that complement you.

> **v1 (browse only):** [isdoomcoding/card-nft-2-binder](https://github.com/isdoomcoding/card-nft-2-binder)

---

## Stack

- Single-file frontend: `card-nft-2-binder.html` (HTML + CSS + JS, no build step)
- Node.js server: `minimal-server.js` — serves the HTML, proxies Helius DAS calls, caches the collection
- Trade module: `trade.js` — SIWS auth, intent store, two-way match engine (zero runtime deps)

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
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run

```bash
node minimal-server.js
```

Open `http://localhost:8788` in your browser.

---

## Trade feature

Wallets connect via Phantom or Solflare, sign a message to prove ownership, then declare:
- **Haves** — cards from their wallet they're willing to trade
- **Wants** — specific cards or trait-based wants (e.g. "any Holo")

The server runs two-way matching: if your haves satisfy someone's wants and their haves satisfy yours, it's a match. Both wallets and the candidate cards are revealed — settlement happens via any swap tool the parties choose (Cofre, Token Entangler, etc.).

---

## License

Fan-made project by [@isdoomcoding](https://github.com/isdoomcoding) / [@DoomOperator](https://x.com/DoomOperator), released as copyleft FOSS under the [AGPL-3.0 license](LICENSE).

Card NFT 2 artwork is by [evil biscuit](https://x.com/bis__cut). This project is not affiliated with or endorsed by evil biscuit.
