// MIM sell monitor — polls CoW Swap for fills of a wallet's standing MIM sell
// order and sends a Telegram message for each new batch that executes.
//
// All configuration comes from environment variables (see .env.example).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const cfg = {
  wallet: requireEnv("WALLET_ADDRESS").toLowerCase(),
  mim: (process.env.MIM_ADDRESS || "0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3").toLowerCase(),
  cowApiBase: process.env.COW_API_BASE || "https://api.cow.fi/mainnet/api/v1",
  // Comma-separated list; tried in order until one answers.
  rpcUrls: (process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com,https://eth.drpc.org")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  chatId: requireEnv("TELEGRAM_CHAT_ID"),
  pollSeconds: Number(process.env.POLL_INTERVAL_SEC || 60),
  stateFile: process.env.STATE_FILE || "./state.json",
  explorerTx: process.env.EXPLORER_TX_BASE || "https://etherscan.io/tx/",
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// State (high-water mark of the last processed trade)
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    return JSON.parse(await readFile(cfg.stateFile, "utf8"));
  } catch {
    return null;
  }
}

async function saveState(state) {
  // Never let a non-writable STATE_FILE crash the process — log and move on.
  try {
    await mkdir(dirname(cfg.stateFile), { recursive: true });
    await writeFile(cfg.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn(`Could not persist state to ${cfg.stateFile}: ${e.message}`);
  }
}

// A trade is "after" the high-water mark if its (block, logIndex) is greater.
function isNewer(trade, mark) {
  if (trade.blockNumber !== mark.lastBlock) return trade.blockNumber > mark.lastBlock;
  return trade.logIndex > mark.lastLogIndex;
}

function markOf(trade) {
  return { lastBlock: trade.blockNumber, lastLogIndex: trade.logIndex };
}

// ---------------------------------------------------------------------------
// CoW Swap
// ---------------------------------------------------------------------------

async function fetchTrades() {
  const url = `${cfg.cowApiBase}/trades?owner=${cfg.wallet}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`CoW API ${res.status}: ${await res.text()}`);
  const trades = await res.json();
  // Only fills where MIM is the token being sold, sorted oldest -> newest.
  return trades
    .filter((t) => t.sellToken.toLowerCase() === cfg.mim)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

// ---------------------------------------------------------------------------
// ERC-20 token metadata (decimals + symbol) via a keyless JSON-RPC endpoint
// ---------------------------------------------------------------------------

// Known mainnet tokens, so common buy tokens format correctly even if every
// RPC endpoint is unavailable.
const tokenCache = new Map([
  ["0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3", { symbol: "MIM", decimals: 18 }],
  ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", { symbol: "USDC", decimals: 6 }],
  ["0xdac17f958d2ee523a2206206994597c13d831ec7", { symbol: "USDT", decimals: 6 }],
  ["0x6b175474e89094c44da98b954eedeac495271d0f", { symbol: "DAI", decimals: 18 }],
  ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", { symbol: "WETH", decimals: 18 }],
  ["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", { symbol: "ETH", decimals: 18 }],
]);
tokenCache.set(cfg.mim, tokenCache.get("0x99d8a9c45b2eca8864373a26d1459e3dff1e17f3") || { symbol: "MIM", decimals: 18 });

async function ethCall(to, data) {
  let lastErr;
  for (const url of cfg.rpcUrls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`RPC error: ${json.error.message}`);
      return json.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no RPC endpoints configured");
}

async function tokenMeta(address) {
  const addr = address.toLowerCase();
  if (tokenCache.has(addr)) return tokenCache.get(addr);
  let meta = { symbol: shortAddr(addr), decimals: 18, resolved: false };
  try {
    const dec = await ethCall(addr, "0x313ce567"); // decimals()
    const sym = await ethCall(addr, "0x95d89b41"); // symbol()
    meta = { symbol: decodeStringResult(sym) || shortAddr(addr), decimals: parseInt(dec, 16), resolved: true };
  } catch (e) {
    console.warn(`Could not resolve token ${addr}: ${e.message} — using fallback`);
  }
  tokenCache.set(addr, meta);
  return meta;
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// Decode an ABI-encoded string return (handles both dynamic string and bytes32).
function decodeStringResult(hex) {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);
  if (body.length === 64) {
    // bytes32-style symbol
    return Buffer.from(body, "hex").toString("utf8").replace(/\0+$/, "").trim() || null;
  }
  // dynamic string: [offset][length][data]
  const len = parseInt(body.slice(64, 128), 16);
  const data = body.slice(128, 128 + len * 2);
  return Buffer.from(data, "hex").toString("utf8").trim() || null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatUnits(raw, decimals, maxFrac = 4) {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const intPart = digits.slice(0, digits.length - decimals);
  let fracPart = digits.slice(digits.length - decimals).slice(0, maxFrac).replace(/0+$/, "");
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (negative ? "-" : "") + withCommas + (fracPart ? "." + fracPart : "");
}

function priceString(sell, buy) {
  // buy per 1 sell, using floating point (display only).
  const s = Number(sell.human.replace(/,/g, ""));
  const b = Number(buy.human.replace(/,/g, ""));
  if (!s || !b) return null;
  return (b / s).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: cfg.chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function sendPhoto(photo, caption) {
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendPhoto`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, photo, caption }),
  });
  if (!res.ok) throw new Error(`Telegram sendPhoto ${res.status}: ${await res.text()}`);
}

async function notifyTrade(trade) {
  const sellMeta = await tokenMeta(trade.sellToken);
  const buyMeta = await tokenMeta(trade.buyToken);
  const sell = { human: formatUnits(trade.sellAmount, sellMeta.decimals), sym: sellMeta.symbol };
  const buy = { human: formatUnits(trade.buyAmount, buyMeta.decimals), sym: buyMeta.symbol };
  const price = priceString(sell, buy);

  const lines = [
    `🟢 *MIM batch sold on CoW Swap*`,
    ``,
    `Sold: *${sell.human} ${sell.sym}*`,
    `For: *${buy.human} ${buy.sym}*`,
    price ? `Price: ${price} ${buy.sym}/${sell.sym}` : null,
    `Block: ${trade.blockNumber}`,
    `[View tx](${cfg.explorerTx}${trade.txHash})`,
  ].filter(Boolean);

  await sendTelegram(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// On-demand price + 24h chart (CoinGecko spot + live Curve pool price)
// ---------------------------------------------------------------------------

const CG = process.env.COINGECKO_BASE || "https://api.coingecko.com/api/v3";
const MIM_CG_ID = process.env.MIM_CG_ID || "magic-internet-money";
// Curve MIM-3CRV metapool + the 3pool (to value the 3CRV leg in USD).
const MIM_POOL = "0x5a6a4d54456819380173272a5e8e9b9904bdf41b";
const THREEPOOL = "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7";
const hx = (n) => BigInt(n).toString(16).padStart(64, "0");

async function cgSpot() {
  const res = await fetch(`${CG}/simple/price?ids=${MIM_CG_ID}&vs_currencies=usd&include_24hr_change=true`);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const m = (await res.json())[MIM_CG_ID] || {};
  return { usd: m.usd, chg: m.usd_24h_change };
}

// What you'd actually receive selling `clipMim` MIM into the pool, per MIM (USD).
async function poolPriceUsd(clipMim) {
  try {
    const dx = BigInt(clipMim) * 10n ** 18n;
    const dyHex = await ethCall(MIM_POOL, "0x5e0d443f" + hx(0) + hx(1) + hx(dx)); // get_dy(0,1,dx)
    const vpHex = await ethCall(THREEPOOL, "0xbb7b8b80"); // get_virtual_price()
    if (!dyHex || !vpHex) return null;
    const usdOut = (Number(BigInt(dyHex)) / 1e18) * (Number(BigInt(vpHex)) / 1e18);
    return usdOut / clipMim;
  } catch {
    return null;
  }
}

async function priceMessage() {
  let spotLine = "Spot: n/a";
  try {
    const s = await cgSpot();
    if (s.usd != null) {
      const chg = s.chg == null ? "" : ` (${s.chg >= 0 ? "+" : ""}${s.chg.toFixed(1)}% 24h)`;
      spotLine = `Spot (CoinGecko): *$${s.usd.toFixed(4)}*${chg}`;
    }
  } catch (e) {
    spotLine = `Spot: n/a (${e.message})`;
  }
  const lines = [`*MIM price*`, spotLine, `Live pool — what you'd actually get:`];
  for (const c of [1000, 10000, 50000]) {
    const p = await poolPriceUsd(c);
    lines.push(`  ${c.toLocaleString("en-US")} MIM → ${p ? "$" + p.toFixed(4) + "/MIM" : "_can't fill_"}`);
  }
  return lines.join("\n");
}

// Build a 24h MIM/USD chart via QuickChart and return a short image URL.
async function chartUrl() {
  const res = await fetch(`${CG}/coins/${MIM_CG_ID}/market_chart?vs_currency=usd&days=1`);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const pts = (await res.json()).prices || [];
  if (!pts.length) return null;
  const step = Math.max(1, Math.floor(pts.length / 48)); // ~48 points
  const sampled = pts.filter((_, i) => i % step === 0);
  const labels = sampled.map(([t]) => new Date(t).toISOString().slice(11, 16));
  const data = sampled.map(([, p]) => Number(p.toFixed(4)));
  const chart = {
    type: "line",
    data: { labels, datasets: [{ label: "MIM/USD", data, borderColor: "rgb(54,162,235)",
      backgroundColor: "rgba(54,162,235,0.15)", fill: true, pointRadius: 0, borderWidth: 2 }] },
    options: { plugins: { title: { display: true, text: `MIM/USD — 24h (now $${data[data.length - 1].toFixed(4)})` } },
      scales: { x: { ticks: { maxTicksLimit: 8 } } } },
  };
  const create = await fetch("https://quickchart.io/chart/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chart, width: 640, height: 360, backgroundColor: "white" }),
  });
  if (!create.ok) return null;
  return (await create.json()).url || null;
}

// ---------------------------------------------------------------------------
// Telegram command handling (long-poll getUpdates) — /price, /chart, /help
// ---------------------------------------------------------------------------

async function handleCommand(text) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace(/^\//, "").split("@")[0];
  if (cmd === "price" || cmd === "p") {
    await sendTelegram(await priceMessage());
  } else if (cmd === "chart" || cmd === "c") {
    const u = await chartUrl();
    if (u) await sendPhoto(u, "MIM/USD — last 24h");
    else await sendTelegram("Chart unavailable right now.");
  } else if (cmd === "help" || cmd === "start") {
    await sendTelegram("*MIM bot*\n/price — spot + live pool price (1k/10k/50k MIM)\n/chart — 24h MIM/USD chart");
  }
}

async function commandLoop() {
  let offset;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${cfg.botToken}/getUpdates?timeout=30${offset ? `&offset=${offset}` : ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`getUpdates ${res.status}`);
      for (const u of (await res.json()).result || []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg || !msg.text) continue;
        if (String(msg.chat.id) !== String(cfg.chatId)) continue; // only the owner chat
        await handleCommand(msg.text).catch((e) => console.error(`cmd ${msg.text}: ${e.message}`));
      }
    } catch (e) {
      console.error(`Command loop: ${e.message}`);
      await sleep(3000);
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function pollOnce(state) {
  const trades = await fetchTrades();
  const fresh = trades.filter((t) => isNewer(t, state));
  for (const t of fresh) {
    await notifyTrade(t);
    Object.assign(state, markOf(t));
    await saveState(state);
    console.log(`Notified trade ${t.txHash} (block ${t.blockNumber}, log ${t.logIndex})`);
  }
  return fresh.length;
}

async function main() {
  console.log(`Monitoring MIM sells for ${cfg.wallet} every ${cfg.pollSeconds}s`);

  let state = await loadState();

  if (!state) {
    // First run: don't replay history. Seed the high-water mark at the latest
    // existing trade and announce that monitoring has started.
    const trades = await fetchTrades();
    const latest = trades[trades.length - 1];
    state = latest ? markOf(latest) : { lastBlock: 0, lastLogIndex: -1 };
    await saveState(state);
    try {
      await sendTelegram(
        `👀 *MIM sell monitor started*\nWatching \`${cfg.wallet}\` for MIM fills on CoW Swap.\n` +
          (latest ? `Caught up to block ${latest.blockNumber}; will notify on the next fill.` : `No prior MIM trades found yet.`)
      );
    } catch (e) {
      console.warn(`Startup Telegram message failed: ${e.message}`);
    }
  }

  // Run the fill-poller and the Telegram command loop (/price, /chart) together.
  await Promise.all([fillPollLoop(state), commandLoop()]);
}

async function fillPollLoop(state) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const n = await pollOnce(state);
      if (n) console.log(`Processed ${n} new fill(s).`);
    } catch (e) {
      console.error(`Poll error: ${e.message}`);
    }
    await sleep(cfg.pollSeconds * 1000);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
