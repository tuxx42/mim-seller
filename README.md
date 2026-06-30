# MIM sell monitor

Watches an Ethereum wallet for **MIM** sells that get filled on **CoW Swap**
(e.g. a standing limit/sell order being executed batch-by-batch) and sends a
**Telegram** message for each new fill.

It polls CoW's orderbook API (`/trades?owner=<wallet>`), filters for trades
where MIM is the sell token, and notifies on anything newer than the last fill
it processed. State is a small high-water mark `(blockNumber, logIndex)` so it
never double-notifies and never replays history on restart.

## How it detects a sale

When your CoW order is (partially) filled, your MIM leaves your wallet and a
trade record appears under your address. Each batch fill is one trade object
with `sellToken=MIM`, `sellAmount`, `buyToken`, `buyAmount`, `txHash`,
`blockNumber`, `logIndex`. There is no timestamp, so ordering/dedupe uses
`(blockNumber, logIndex)`.

## On-demand commands

Besides push alerts, the bot replies to messages **from `TELEGRAM_CHAT_ID`** only:

- `/price` — CoinGecko spot + live **Curve-pool** price for 1k / 10k / 50k MIM (what you'd actually receive on a sale).
- `/chart` — a **24h MIM/USD chart** (rendered via QuickChart, sent as a photo).
- `/help` — command list.

This uses Telegram long-polling (`getUpdates`), so **run only one instance** at a
time (the Railway worker *or* a local run, not both) — two consumers conflict
(HTTP 409). Optional env: `MIM_CG_ID` (default `magic-internet-money`),
`COINGECKO_BASE`.

## 1. Create a Telegram bot (2 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts.
2. It gives you a **bot token** like `123456:ABC...` → this is `TELEGRAM_BOT_TOKEN`.
3. Send your new bot any message (e.g. "hi") so it can message you back.
4. Get your **chat id**: open
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and read
   `result[].message.chat.id` → this is `TELEGRAM_CHAT_ID`.
   (For a group, add the bot to the group, post a message, and use the negative
   group chat id.)

## 2. Run locally

### Option A — macOS Keychain (no secrets in files)

Store the bot token once (input is hidden, nothing is echoed or written to a
file):

```fish
security add-generic-password -a TELEGRAM_BOT_TOKEN -s "telegram bot token" -w
# optional: store the chat id too
security add-generic-password -a TELEGRAM_CHAT_ID -s "telegram chat id" -w
```

Then run via the helper, which pulls them from the Keychain:

```fish
./run-local.fish
```

Retrieve or delete the stored token anytime:

```fish
security find-generic-password -a TELEGRAM_BOT_TOKEN -s "telegram bot token" -w   # print
security delete-generic-password -a TELEGRAM_BOT_TOKEN -s "telegram bot token"    # remove
```

### Option B — .env file

```bash
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
npm start
```

On first run it sends a "monitor started" message and seeds itself to the
latest existing trade — so you'll only get pinged on the *next* fill.

> The Keychain is local-only. On **Railway**, set the token as a Railway
> **Variable** (its own encrypted secret store) — see §3.

## 3. Deploy on Railway

1. Push this folder to a Git repo (or use `railway up`).
2. New Railway project → deploy from the repo. Nixpacks auto-detects Node and
   runs `npm start` (also pinned in `railway.json`). **No public port / domain
   needed — this is a worker, not a web service.**
3. In the service **Variables**, set:
   - `WALLET_ADDRESS` = your wallet (the one with the MIM sell order)
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `STATE_FILE` = `/data/state.json`
4. Add a **Volume** to the service mounted at `/data` so the high-water mark
   survives restarts/redeploys (otherwise a redeploy re-seeds to "now", which
   is safe but means a fill during the redeploy window could be missed).

That's it. Leave it running; it polls every 60s by default.

## Configuration

See `.env.example`. Everything except the wallet and Telegram creds has a
sensible default. To watch MIM on another chain, change `MIM_ADDRESS`,
`COW_API_BASE` (e.g. `https://api.cow.fi/arbitrum_one/api/v1`), and
`EXPLORER_TX_BASE`.
