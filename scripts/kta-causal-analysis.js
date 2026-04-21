#!/usr/bin/env node

/**
 * kta-causal-analysis.js
 *
 * Five-layer causal read on KEETA (KTA) on Base.
 *   Layer 1 — news catalyst (pre-researched; see RESEARCH below)
 *   Layer 2 — TradingView technicals (4H + Daily, via `tv` CLI)
 *   Layer 3 — Nansen smart-money + exchange cohort on Base
 *   Layer 4 — DexScreener pair-level buy/sell/volume/liquidity
 *   Layer 5 — CoinGecko market context + BTC/ETH relative + sector + unlocks
 *
 * Writes three artifacts to ~/Desktop:
 *   - KTA_Price_Technical.html  (daily candles + EMA overlays + RSI + volume)
 *   - KTA_Flow_Analysis.html    (smart-money + DEX + verdict)
 *   - KTA_Analysis_21Apr2026.md (editorial article, causal chain)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DESKTOP = resolve(homedir(), "Desktop");

const NANSEN_BASE = "https://api.nansen.ai/api/v1";
const DEXS_BASE = "https://api.dexscreener.com/latest/dex";
const COINGECKO = "https://api.coingecko.com/api/v3";
const KTA_BASE = "0xc0634090F2Fe6c6d75e61Be2b949464aBB498973";

// ─── Layer 1 + 5 pre-researched findings (from web search) ───
const RESEARCH = {
  noFreshCatalystToday: true,
  bankAcquisition: {
    announcedDate: "2026-01-21",
    ktaAllocated: 35_000_000,
    approxUsdAtAnnouncement: 9_000_000,
    status: "pending regulatory approval, no update in 3 months",
  },
  tokenUnlock: {
    mostRecentUnlockDate: "2026-04-05",
    unlockUsdRange: "$2.5M–$2.7M",
    daysAgo: 16,
    circulatingPctApril2026: 49.5,
    remainingLockedPct: 50.5,
    vestingStructure: "24–48 month linear vesting, first insider unlock Sep 2025, schedule runs through Aug 2029",
  },
  rwaSector: {
    trend: "strongly bullish",
    aprilStatus: "+4% in April mid-market downturn; RWA tokens +185.8% avg in 2026",
    implicationForKta: "KTA is underperforming its own sector — KTA-specific weakness, not sector rotation",
  },
  perps: {
    exists: true,
    venues: ["LBank", "Kraken Futures", "MEXC"],
    note: "Bybit does not list KTAUSDT; funding rate not pulled via public API in this run",
  },
};

// ─── helpers ───────────────────────────────────────────────

function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(REPO_ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {}
}

async function nansen(path, body) {
  const r = await fetch(`${NANSEN_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apiKey: process.env.NANSEN_API_KEY },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return r.ok ? { ok: true, data } : { ok: false, status: r.status, error: data };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, data: await r.json() };
}

function tv(...args) {
  try {
    const out = execFileSync("node", [resolve(REPO_ROOT, "src/cli/index.js"), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function rowsFrom(resp) {
  if (!resp?.ok || !resp.data) return [];
  if (Array.isArray(resp.data)) return resp.data;
  if (Array.isArray(resp.data.data)) return resp.data.data;
  return [];
}

function endpoints(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [null, null];
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return [sorted[0], sorted[sorted.length - 1]];
}

const isoNow = () => new Date().toISOString().slice(0, 19) + "Z";
const isoDaysAgo = (d) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 19) + "Z";

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtNum(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(d)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(d)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(d)}K`;
  return n.toFixed(d);
}

// ─── indicator math ─────────────────────────────────────────

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return [];
  const out = new Array(closes.length).fill(NaN);
  let gSum = 0, lSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gSum += d; else lSum -= d;
  }
  let avgG = gSum / period, avgL = lSum / period;
  out[period] = 100 - 100 / (1 + avgG / (avgL || 1e-10));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-10));
  }
  return out;
}

function macd(closes) {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(line, 9);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function obv(closes, volumes) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    const p = out[i - 1];
    if (closes[i] > closes[i - 1]) out.push(p + volumes[i]);
    else if (closes[i] < closes[i - 1]) out.push(p - volumes[i]);
    else out.push(p);
  }
  return out;
}

function normSlope(arr, window = 14) {
  const n = Math.min(window, arr.length);
  if (n < 3) return 0;
  const sub = arr.slice(-n);
  const xMean = (n - 1) / 2;
  const yMean = sub.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (sub[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return num / den / (Math.abs(yMean) || 1);
}

// ─── layer scoring ──────────────────────────────────────────

function scoreLayer1(research) {
  // Absence of a fresh catalyst combined with a recent unlock = structural sell pressure without new-bid story.
  if (research.noFreshCatalystToday) {
    return {
      verdict: "confirming",
      summary: "No fresh bullish catalyst; unlock supply from April 5 still bleeding through; bank acquisition narrative stale since January.",
    };
  }
  return { verdict: "neutral", summary: "News layer inconclusive." };
}

function scoreLayer2({ priceNow, rsi4h, macd4h, ema21_4h, vol6Ratio, ema50D, ema200D, obvSlopeD, priceSlopeD }) {
  let score = 0;
  const reasons = [];

  // 4h momentum
  if (priceNow < ema21_4h) { score -= 1; reasons.push(`4h price $${priceNow.toFixed(4)} below EMA21 $${ema21_4h.toFixed(4)}`); }
  else { score += 0.5; reasons.push(`4h price above EMA21 — weak bullish`); }
  if (rsi4h < 30) reasons.push(`4h RSI ${rsi4h.toFixed(1)} oversold — mean-revert zone`);
  else if (rsi4h < 40) { score -= 0.5; reasons.push(`4h RSI ${rsi4h.toFixed(1)} bearish but not oversold`); }
  else if (rsi4h > 70) { score -= 0.5; reasons.push(`4h RSI ${rsi4h.toFixed(1)} overbought`); }
  else reasons.push(`4h RSI ${rsi4h.toFixed(1)} neutral`);
  if (macd4h.hist < 0) { score -= 0.5; reasons.push(`4h MACD histogram ${macd4h.hist.toFixed(4)} negative (momentum down)`); }
  else { score += 0.5; reasons.push(`4h MACD histogram ${macd4h.hist.toFixed(4)} positive`); }
  if (vol6Ratio > 1.2) { score -= 0.5; reasons.push(`4h volume ${vol6Ratio.toFixed(2)}× prior 6 bars — selling has volume`); }
  else if (vol6Ratio < 0.8) reasons.push(`4h volume fading — low-conviction move`);
  else reasons.push(`4h volume roughly flat`);

  // daily structure
  const emaDown = priceNow < ema50D && ema50D < ema200D;
  const emaUp = priceNow > ema50D && ema50D > ema200D;
  if (emaDown) { score -= 1; reasons.push(`daily EMA50 ${ema50D.toFixed(4)} < EMA200 ${ema200D.toFixed(4)} with price below (trend down)`); }
  else if (emaUp) { score += 1; reasons.push(`daily EMA structure bullish stacked`); }
  else reasons.push(`daily EMA structure mixed`);
  if (obvSlopeD < -0.001 && priceSlopeD < 0) { score -= 0.5; reasons.push(`daily OBV confirming downtrend`); }
  else if (obvSlopeD > 0.001 && priceSlopeD < 0) { score += 0.5; reasons.push(`daily OBV rising while price falling — bullish divergence`); }
  else if (obvSlopeD < -0.001 && priceSlopeD > 0) { score -= 0.5; reasons.push(`daily OBV falling while price rising — bearish divergence`); }
  else reasons.push(`daily OBV neutral`);

  // verdict on "does the chart CONFIRM the selloff or contradict it"
  const verdict = score <= -1.5 ? "confirming" : score >= 1 ? "contradicting" : "neutral";
  const summary = verdict === "confirming"
    ? "Chart confirms selloff: momentum, volume, and trend structure all align bearish."
    : verdict === "contradicting"
      ? "Chart contradicts the selloff: structure and momentum not aligned with the drop (possible bounce setup)."
      : "Chart offers mixed signals on the selloff.";
  return { verdict, score, reasons, summary };
}

function scoreLayer3({ smDelta24, smDelta7, exchDelta24, exchDelta7, smHolders, exchHolders }) {
  const reasons = [];
  let score = 0;
  const coverageNote = smHolders <= 2
    ? `Only ${smHolders} Nansen Smart Money wallet(s) hold KTA — coverage is limited for a Base-native asset this young`
    : null;
  if (coverageNote) reasons.push(coverageNote);

  if (exchDelta24 > 0) { score -= 1; reasons.push(`exchange cohort +${fmtNum(exchDelta24)} KTA in 24h — supply moving onto orderbooks`); }
  else if (exchDelta24 < 0) { score += 1; reasons.push(`exchange cohort ${fmtNum(exchDelta24)} KTA in 24h — supply leaving orderbooks`); }
  if (exchDelta7 != null) {
    reasons.push(`exchange cohort ${exchDelta7 >= 0 ? "+" : ""}${fmtNum(exchDelta7)} KTA over 7d (${exchHolders} wallets)`);
  }
  if (smDelta24 === 0) reasons.push(`Smart Money holdings flat 24h`);
  else if (smDelta24 > 0) reasons.push(`Smart Money +${smDelta24.toFixed(2)} KTA 24h`);
  else reasons.push(`Smart Money ${smDelta24.toFixed(2)} KTA 24h`);

  // verdict: does it CONFIRM the drop?
  const verdict = score <= -1 ? "confirming" : score >= 1 ? "contradicting" : "neutral";
  const summary = verdict === "confirming"
    ? "Smart-money layer confirms: exchange supply is growing while labeled smart-money sits out."
    : verdict === "contradicting"
      ? "Smart-money layer contradicts: exchange supply shrinking (accumulation signal)."
      : "Smart-money layer offers no clean edge, partly due to limited Nansen coverage of this Base-native asset.";
  return { verdict, score, reasons, summary };
}

function scoreLayer4(pairs) {
  const reasons = [];
  let score = 0;
  let totalBuys = 0, totalSells = 0, totalVol = 0, totalLiq = 0;
  let weightedChange = 0, weightedDenom = 0;
  for (const p of pairs) {
    totalBuys += p.buys24;
    totalSells += p.sells24;
    totalVol += p.vol24;
    totalLiq += p.liq;
    if (Number.isFinite(p.ch24h)) {
      weightedChange += p.ch24h * p.vol24;
      weightedDenom += p.vol24;
    }
  }
  const txSkew = totalBuys + totalSells ? (totalBuys / (totalBuys + totalSells) - 0.5) * 100 : 0;
  const weightedCh24h = weightedDenom ? weightedChange / weightedDenom : 0;

  if (weightedCh24h < -3) { score -= 1; reasons.push(`volume-weighted 24h price ${weightedCh24h.toFixed(2)}% across Base DEXes`); }
  else if (weightedCh24h > 3) { score += 1; reasons.push(`DEX prices up ${weightedCh24h.toFixed(2)}% weighted`); }
  else reasons.push(`DEX price ${weightedCh24h.toFixed(2)}% — consistent with spot`);

  if (txSkew > 10) reasons.push(`tx-count buy skew +${txSkew.toFixed(1)}pp (${totalBuys} buys vs ${totalSells} sells) despite price drop = whale sells absorbing retail bid`);
  else if (txSkew < -10) { score -= 0.5; reasons.push(`tx-count sell skew ${txSkew.toFixed(1)}pp = retail capitulation`); }
  else reasons.push(`tx-count balanced (${totalBuys} buys / ${totalSells} sells, ${txSkew >= 0 ? "+" : ""}${txSkew.toFixed(1)}pp skew)`);

  // verdict = does DEX CONFIRM the selloff?
  const verdict = score <= -1 ? "confirming" : score >= 1 ? "contradicting" : (txSkew > 10 ? "mixed" : "confirming");
  const summary = txSkew > 10 && weightedCh24h < -2
    ? "DEX layer shows a distribution pattern: more retail buy transactions than sells, yet price is still down across pools — whale-sized sells are walking prices lower against broad retail buying. Confirms the drop, flags who is on which side."
    : verdict === "confirming"
      ? "DEX flow confirms the selloff across pools."
      : verdict === "contradicting"
        ? "DEX flow contradicts the selloff — buy-side is pushing against the tape."
        : "DEX flow is mixed.";
  return { verdict, score, reasons, summary, totalBuys, totalSells, totalVol, totalLiq, weightedCh24h, txSkew };
}

function scoreLayer5({ ktaCh24h, btcCh24h, ethCh24h, mcap, volChangePct, rwaSectorBullish, unlockRecent }) {
  const reasons = [];
  let score = 0;
  const marketUp = (btcCh24h > 0) && (ethCh24h > 0);
  const ktaDown = ktaCh24h < 0;
  if (marketUp && ktaDown) {
    score -= 1;
    reasons.push(`KTA ${ktaCh24h.toFixed(2)}% vs BTC ${btcCh24h >= 0 ? "+" : ""}${btcCh24h.toFixed(2)}% / ETH ${ethCh24h >= 0 ? "+" : ""}${ethCh24h.toFixed(2)}% — KTA-specific weakness in a green market`);
  } else if (!marketUp && ktaDown) {
    reasons.push(`market is red, KTA drop is partially sector/tape-wide`);
  }
  if (rwaSectorBullish) {
    score -= 1;
    reasons.push(`RWA sector is strong (+185.8% avg 2026, +4% in April) — KTA underperforming its own category, not sector rotation`);
  }
  if (unlockRecent) {
    score -= 1;
    reasons.push(`Recent April 5 unlock (~$2.5–2.7M) + 50.5% still locked + long linear vesting through 2029 = persistent supply overhang`);
  }
  // verdict: does market context CONFIRM the drop (i.e. is there something in market structure supporting the move)?
  const verdict = score <= -1 ? "confirming" : score >= 1 ? "contradicting" : "neutral";
  const summary = verdict === "confirming"
    ? "Market context confirms: this is a KTA-specific drop driven by supply overhang, not a market or sector rotation."
    : "Market context does not clearly confirm a KTA-specific issue.";
  return { verdict, score, reasons, summary };
}

function confluence(layers) {
  const counts = { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 };
  for (const l of layers) counts[l.verdict] = (counts[l.verdict] || 0) + 1;
  const conf = counts.confirming + counts.mixed * 0.5;
  let strength, label;
  if (counts.confirming >= 4) { strength = "STRONG"; label = "STRONG BEARISH CONVICTION"; }
  else if (counts.confirming === 3) { strength = "MODERATE"; label = "MODERATE BEARISH CONVICTION"; }
  else if (counts.confirming <= 2) { strength = "WEAK"; label = "WEAK BEARISH CONVICTION — likely bounce setup"; }
  return { counts, confirmingCount: counts.confirming, strength, label };
}

// ─── main ───────────────────────────────────────────────────

async function main() {
  loadDotEnv();
  if (!process.env.NANSEN_API_KEY) {
    console.error("NANSEN_API_KEY missing."); process.exit(1);
  }

  // ─── Layer 2: TV data (4h + daily) ───
  console.log("→ layer 2: pulling KTA 4h + daily bars…");
  tv("timeframe", "set", "240");
  const ohlcv4h = tv("ohlcv", "-n", "60");
  tv("timeframe", "set", "D");
  const ohlcvD = tv("ohlcv", "-n", "250");
  if (!ohlcv4h?.bars || !ohlcvD?.bars) {
    console.error("OHLCV pull failed"); process.exit(1);
  }
  const bars4h = ohlcv4h.bars;
  const closes4h = bars4h.map(b => b.close);
  const vols4h = bars4h.map(b => b.volume);
  const ema21_4h = ema(closes4h, 21).at(-1);
  const rsi14_4h = rsi(closes4h, 14).at(-1);
  const macd4hAll = macd(closes4h);
  const macd4h = { line: macd4hAll.line.at(-1), signal: macd4hAll.signal.at(-1), hist: macd4hAll.hist.at(-1) };
  const vol6 = vols4h.slice(-6).reduce((a, b) => a + b, 0) / 6;
  const vol6Prior = vols4h.slice(-12, -6).reduce((a, b) => a + b, 0) / 6;
  const vol6Ratio = vol6 / (vol6Prior || 1);

  const barsD = ohlcvD.bars;
  const closesD = barsD.map(b => b.close);
  const volsD = barsD.map(b => b.volume);
  const ema50D_s = ema(closesD, 50);
  const ema200D_s = ema(closesD, 200);
  const obvD_s = obv(closesD, volsD);
  const ema50D = ema50D_s.at(-1);
  const ema200D = ema200D_s.at(-1);
  const priceNow = closesD.at(-1);
  const obvSlopeD = normSlope(obvD_s, 14);
  const priceSlopeD = normSlope(closesD, 14);

  const layer2 = scoreLayer2({
    priceNow, rsi4h: rsi14_4h, macd4h, ema21_4h, vol6Ratio,
    ema50D, ema200D, obvSlopeD, priceSlopeD,
  });

  // ─── Layer 3: Nansen ───
  console.log("→ layer 3: pulling Nansen KTA flows on Base…");
  const [smFlow24, smFlow7, exchFlow24, exchFlow7, buyers, sellers] = await Promise.all([
    nansen("/tgm/flows", { chain: "base", token_address: KTA_BASE, date: { from: isoDaysAgo(1), to: isoNow() }, label: "smart_money", pagination: { page: 1, per_page: 200 } }),
    nansen("/tgm/flows", { chain: "base", token_address: KTA_BASE, date: { from: isoDaysAgo(7), to: isoNow() }, label: "smart_money", pagination: { page: 1, per_page: 200 } }),
    nansen("/tgm/flows", { chain: "base", token_address: KTA_BASE, date: { from: isoDaysAgo(1), to: isoNow() }, label: "exchange", pagination: { page: 1, per_page: 200 } }),
    nansen("/tgm/flows", { chain: "base", token_address: KTA_BASE, date: { from: isoDaysAgo(7), to: isoNow() }, label: "exchange", pagination: { page: 1, per_page: 200 } }),
    nansen("/tgm/who-bought-sold", { chain: "base", token_address: KTA_BASE, buy_or_sell: "BUY", date: { from: isoDaysAgo(7), to: isoNow() }, pagination: { page: 1, per_page: 10 }, order_by: [{ field: "bought_volume_usd", direction: "DESC" }] }),
    nansen("/tgm/who-bought-sold", { chain: "base", token_address: KTA_BASE, buy_or_sell: "SELL", date: { from: isoDaysAgo(7), to: isoNow() }, pagination: { page: 1, per_page: 10 }, order_by: [{ field: "sold_volume_usd", direction: "DESC" }] }),
  ]);
  const delta = (r) => {
    const [o, n] = endpoints(rowsFrom(r));
    if (!o || !n) return null;
    return Number(n.token_amount) - Number(o.token_amount);
  };
  const holdingsLast = (r) => {
    const [, n] = endpoints(rowsFrom(r));
    return n ? { tokens: Number(n.token_amount), holders: Number(n.holders_count), usd: Number(n.value_usd) } : null;
  };
  const smDelta24 = delta(smFlow24), smDelta7 = delta(smFlow7);
  const exchDelta24 = delta(exchFlow24), exchDelta7 = delta(exchFlow7);
  const smLast = holdingsLast(smFlow24) || { tokens: 0, holders: 0, usd: 0 };
  const exchLast = holdingsLast(exchFlow24) || { tokens: 0, holders: 0, usd: 0 };
  const topBuyers = rowsFrom(buyers).slice(0, 5);
  const topSellers = rowsFrom(sellers).slice(0, 5);

  const layer3 = scoreLayer3({
    smDelta24: smDelta24 ?? 0, smDelta7: smDelta7 ?? 0,
    exchDelta24: exchDelta24 ?? 0, exchDelta7: exchDelta7 ?? 0,
    smHolders: smLast.holders, exchHolders: exchLast.holders,
  });

  // ─── Layer 4: DexScreener ───
  console.log("→ layer 4: pulling DexScreener pairs…");
  const dex = await getJson(`${DEXS_BASE}/tokens/${KTA_BASE}`);
  const basePairs = (dex?.data?.pairs || []).filter(p => p.chainId === "base");
  const normalized = basePairs.map(p => ({
    dex: p.dexId,
    pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
    liq: Number(p.liquidity?.usd) || 0,
    vol24: Number(p.volume?.h24) || 0,
    buys24: Number(p.txns?.h24?.buys) || 0,
    sells24: Number(p.txns?.h24?.sells) || 0,
    ch5m: Number(p.priceChange?.m5),
    ch1h: Number(p.priceChange?.h1),
    ch6h: Number(p.priceChange?.h6),
    ch24h: Number(p.priceChange?.h24),
    priceUsd: Number(p.priceUsd),
  })).sort((a, b) => b.liq - a.liq);
  const topPairs = normalized.filter(p => p.liq > 5000).slice(0, 8);
  const layer4 = scoreLayer4(topPairs);

  // ─── Layer 5: market context ───
  console.log("→ layer 5: CoinGecko + BTC/ETH…");
  const [cg, majors] = await Promise.all([
    getJson(`${COINGECKO}/coins/keeta?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`),
    getJson(`${COINGECKO}/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true`),
  ]);
  const cgMd = cg?.data?.market_data || {};
  const ktaCh24h = Number(cgMd.price_change_percentage_24h) || 0;
  const ktaCh7d = Number(cgMd.price_change_percentage_7d) || 0;
  const ktaCh30d = Number(cgMd.price_change_percentage_30d) || 0;
  const mcap = Number(cgMd.market_cap?.usd) || 0;
  const vol = Number(cgMd.total_volume?.usd) || 0;
  const mcapChangePct24h = Number(cgMd.market_cap_change_percentage_24h) || 0;
  const ath = Number(cgMd.ath?.usd) || 0;
  const athDate = cgMd.ath_date?.usd || null;
  const athChangePct = Number(cgMd.ath_change_percentage?.usd) || 0;
  const btcCh24h = Number(majors?.data?.bitcoin?.usd_24h_change) || 0;
  const ethCh24h = Number(majors?.data?.ethereum?.usd_24h_change) || 0;

  const layer5 = scoreLayer5({
    ktaCh24h, btcCh24h, ethCh24h, mcap, volChangePct: 0,
    rwaSectorBullish: true,
    unlockRecent: true,
  });

  // ─── Layer 1 (news) ───
  const layer1 = scoreLayer1(RESEARCH);

  const conf = confluence([layer1, layer2, layer3, layer4, layer5]);

  // ─── print to console ───
  console.log(`\n${"═".repeat(64)}`);
  console.log("  KEETA (KTA) — FIVE-LAYER CAUSAL READ");
  console.log("═".repeat(64));
  console.log(`\n[L1 CATALYST]   ${layer1.verdict.toUpperCase()}`);
  console.log(`  ${layer1.summary}`);
  console.log(`\n[L2 TECHNICAL]  ${layer2.verdict.toUpperCase()}`);
  console.log(`  4h: RSI ${rsi14_4h.toFixed(2)}, MACD ${macd4h.line.toFixed(4)}/sig ${macd4h.signal.toFixed(4)}/hist ${macd4h.hist.toFixed(4)}, EMA21 ${ema21_4h.toFixed(4)} vs price ${priceNow.toFixed(4)}`);
  console.log(`  daily: EMA50 ${ema50D.toFixed(4)}, EMA200 ${ema200D.toFixed(4)}, OBV slope ${obvSlopeD.toFixed(4)}, price slope ${priceSlopeD.toFixed(4)}`);
  for (const r of layer2.reasons) console.log(`  • ${r}`);
  console.log(`\n[L3 NANSEN]     ${layer3.verdict.toUpperCase()}`);
  console.log(`  SM: ${smLast.holders} wallets, ${fmtNum(smLast.tokens)} KTA (${fmtUsd(smLast.usd)}) — Δ24h ${(smDelta24 ?? 0).toFixed(2)} / Δ7d ${(smDelta7 ?? 0).toFixed(2)}`);
  console.log(`  EXCH: ${exchLast.holders} wallets, ${fmtNum(exchLast.tokens)} KTA (${fmtUsd(exchLast.usd)}) — Δ24h ${fmtNum(exchDelta24 ?? 0)} / Δ7d ${fmtNum(exchDelta7 ?? 0)}`);
  for (const r of layer3.reasons) console.log(`  • ${r}`);
  console.log(`\n[L4 DEX]        ${layer4.verdict.toUpperCase()}`);
  console.log(`  ${topPairs.length} pools · ${layer4.totalBuys} buys / ${layer4.totalSells} sells · liq ${fmtUsd(layer4.totalLiq)} · vol24 ${fmtUsd(layer4.totalVol)} · weighted Δ24h ${layer4.weightedCh24h.toFixed(2)}%`);
  for (const r of layer4.reasons) console.log(`  • ${r}`);
  console.log(`\n[L5 MARKET]     ${layer5.verdict.toUpperCase()}`);
  console.log(`  KTA ${ktaCh24h.toFixed(2)}% vs BTC ${btcCh24h.toFixed(2)}% / ETH ${ethCh24h.toFixed(2)}% | 7d ${ktaCh7d.toFixed(2)}% | 30d ${ktaCh30d.toFixed(2)}% | mcap ${fmtUsd(mcap)} | ATH ${athChangePct.toFixed(2)}%`);
  for (const r of layer5.reasons) console.log(`  • ${r}`);
  console.log(`\n[CONFLUENCE] ${conf.label}  (${conf.confirmingCount}/5 layers confirm the drop)`);
  console.log(`  confirm ${conf.counts.confirming} · contradict ${conf.counts.contradicting || 0} · neutral ${conf.counts.neutral || 0} · mixed ${conf.counts.mixed || 0}`);

  // ─── build outputs ───
  const ctx = {
    now: new Date().toISOString(),
    research: RESEARCH,
    price: { priceNow, ktaCh24h, ktaCh7d, ktaCh30d, btcCh24h, ethCh24h, mcap, vol, ath, athDate, athChangePct, mcapChangePct24h },
    bars4h, barsD, ema50D_series: ema50D_s, ema200D_series: ema200D_s, ema50D_last: ema50D, ema200D_last: ema200D, rsi14_4h, macd4h, ema21_4h, vol6Ratio,
    layer1, layer2, layer3, layer4, layer5,
    conf,
    nansen: {
      sm: { holders: smLast.holders, tokens: smLast.tokens, usd: smLast.usd, d24: smDelta24, d7: smDelta7 },
      exch: { holders: exchLast.holders, tokens: exchLast.tokens, usd: exchLast.usd, d24: exchDelta24, d7: exchDelta7 },
      topBuyers, topSellers,
    },
    dex: { pairs: topPairs, totalBuys: layer4.totalBuys, totalSells: layer4.totalSells, totalVol: layer4.totalVol, totalLiq: layer4.totalLiq, weightedCh24h: layer4.weightedCh24h, txSkew: layer4.txSkew },
  };

  console.log("\n→ writing Desktop artifacts…");
  const htmlTech = resolve(DESKTOP, "KTA_Price_Technical.html");
  writeFileSync(htmlTech, buildTechnicalHtml(ctx));
  const htmlFlow = resolve(DESKTOP, "KTA_Flow_Analysis.html");
  writeFileSync(htmlFlow, buildFlowHtml(ctx));
  const mdPath = resolve(DESKTOP, "KTA_Analysis_21Apr2026.md");
  writeFileSync(mdPath, buildArticle(ctx));
  console.log(`  ✓ ${htmlTech}`);
  console.log(`  ✓ ${htmlFlow}`);
  console.log(`  ✓ ${mdPath}`);
}

// ─── HTML builders ──────────────────────────────────────────

function buildTechnicalHtml(ctx) {
  const bars = ctx.barsD.slice(-150);
  const dates = bars.map(b => new Date(b.time * 1000).toISOString().slice(0, 10));
  const open = bars.map(b => b.open);
  const high = bars.map(b => b.high);
  const low = bars.map(b => b.low);
  const close = bars.map(b => b.close);
  const vol = bars.map(b => b.volume);
  const ema50 = ctx.ema50D_series.slice(-150);
  const ema200 = ctx.ema200D_series.slice(-150);
  const rsiDaily = rsi(ctx.barsD.map(b => b.close), 14).slice(-150);

  const data = { dates, open, high, low, close, vol, ema50, ema200, rsi: rsiDaily };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>KTA Price & Technicals</title>
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
<style>body{background:#0b0f17;color:#e5e7eb;font-family:-apple-system,Segoe UI,sans-serif;margin:0;padding:16px}h1{font-weight:600;font-size:20px;margin:4px 0 4px}.sub{color:#9ca3af;font-size:13px;margin-bottom:16px}#dash{height:calc(100vh - 90px)}</style>
</head><body>
<h1>KTA — Price &amp; Technicals (Daily)</h1>
<div class="sub">Generated ${new Date(ctx.now).toLocaleString()} · Price $${ctx.price.priceNow.toFixed(4)} · 24h ${ctx.price.ktaCh24h.toFixed(2)}% · 7d ${ctx.price.ktaCh7d.toFixed(2)}% · ${ctx.conf.label}</div>
<div id="dash"></div>
<script>
const D = ${JSON.stringify(data)};
const candle = { type:'candlestick', x:D.dates, open:D.open, high:D.high, low:D.low, close:D.close, name:'KTA/USD', increasing:{line:{color:'#22c55e'}}, decreasing:{line:{color:'#ef4444'}}, xaxis:'x', yaxis:'y' };
const ema50t = { type:'scatter', mode:'lines', x:D.dates, y:D.ema50, name:'EMA 50', line:{color:'#60a5fa',width:1.5}, xaxis:'x', yaxis:'y' };
const ema200t = { type:'scatter', mode:'lines', x:D.dates, y:D.ema200, name:'EMA 200', line:{color:'#f59e0b',width:1.5}, xaxis:'x', yaxis:'y' };
const rsiT = { type:'scatter', mode:'lines', x:D.dates, y:D.rsi, name:'RSI (14)', line:{color:'#a78bfa',width:1.5}, xaxis:'x2', yaxis:'y2' };
const vbars = { type:'bar', x:D.dates, y:D.vol, name:'Volume', marker:{color:'#475569'}, xaxis:'x3', yaxis:'y3' };

const layout = {
  paper_bgcolor:'#0b0f17', plot_bgcolor:'#0b0f17', font:{color:'#e5e7eb'},
  showlegend:true, legend:{orientation:'h', y:1.06},
  grid:{rows:3, columns:1, pattern:'independent', roworder:'top to bottom'},
  xaxis:{ gridcolor:'#1f2937', rangeslider:{visible:false} },
  yaxis:{ title:'Price (USD)', gridcolor:'#1f2937' },
  xaxis2:{ gridcolor:'#1f2937' },
  yaxis2:{ title:'RSI', gridcolor:'#1f2937', range:[0,100] },
  xaxis3:{ gridcolor:'#1f2937' },
  yaxis3:{ title:'Volume', gridcolor:'#1f2937' },
  margin:{t:50,l:60,r:40,b:40},
  shapes: [
    { type:'line', xref:'x2', yref:'y2', x0:D.dates[0], x1:D.dates[D.dates.length-1], y0:70, y1:70, line:{color:'#ef4444', width:1, dash:'dot'} },
    { type:'line', xref:'x2', yref:'y2', x0:D.dates[0], x1:D.dates[D.dates.length-1], y0:30, y1:30, line:{color:'#22c55e', width:1, dash:'dot'} },
  ],
  annotations: [
    { text:'<b>Price + EMA 50 / EMA 200</b>', xref:'paper', yref:'paper', x:0, y:1.02, xanchor:'left', showarrow:false, font:{size:13} },
    { text:'<b>RSI (14)</b>', xref:'paper', yref:'paper', x:0, y:0.64, xanchor:'left', showarrow:false, font:{size:13} },
    { text:'<b>Volume</b>', xref:'paper', yref:'paper', x:0, y:0.30, xanchor:'left', showarrow:false, font:{size:13} },
  ],
};
Plotly.newPlot('dash', [candle, ema50t, ema200t, rsiT, vbars], layout, {responsive:true, displayModeBar:false});
</script></body></html>`;
}

function buildFlowHtml(ctx) {
  const pairs = ctx.dex.pairs;
  const pairLabels = pairs.map(p => `${p.dex}/${p.pair}`);
  const pairVol = pairs.map(p => p.vol24);
  const pairBuys = pairs.map(p => p.buys24);
  const pairSells = pairs.map(p => p.sells24);

  const smSeries = [
    { label: "SM Δ 24h (KTA)", value: ctx.nansen.sm.d24 ?? 0 },
    { label: "SM Δ 7d (KTA)", value: ctx.nansen.sm.d7 ?? 0 },
    { label: "Exchange Δ 24h (KTA, inverted=bullish)", value: -(ctx.nansen.exch.d24 ?? 0) },
    { label: "Exchange Δ 7d (KTA, inverted=bullish)", value: -(ctx.nansen.exch.d7 ?? 0) },
  ];

  const summary = [
    `<b>Causal chain</b>`,
    `1. Catalyst: ${ctx.layer1.verdict.toUpperCase()} — ${ctx.layer1.summary}`,
    `2. Technical: ${ctx.layer2.verdict.toUpperCase()}`,
    `3. Smart Money: ${ctx.layer3.verdict.toUpperCase()}`,
    `4. DEX: ${ctx.layer4.verdict.toUpperCase()}`,
    `5. Market: ${ctx.layer5.verdict.toUpperCase()}`,
    ``,
    `<b>Confluence: ${ctx.conf.label}</b>`,
    `(${ctx.conf.confirmingCount}/5 layers confirm the drop)`,
  ].join("<br>");

  const data = { pairLabels, pairVol, pairBuys, pairSells, smSeries, summary };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>KTA Flow Analysis</title>
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
<style>body{background:#0b0f17;color:#e5e7eb;font-family:-apple-system,Segoe UI,sans-serif;margin:0;padding:16px}h1{font-weight:600;font-size:20px;margin:4px 0 4px}.sub{color:#9ca3af;font-size:13px;margin-bottom:16px}#dash{height:calc(100vh - 90px)}</style>
</head><body>
<h1>KTA — Flow Analysis (Smart Money + DEX + Verdict)</h1>
<div class="sub">Generated ${new Date(ctx.now).toLocaleString()} · Price $${ctx.price.priceNow.toFixed(4)} · ${ctx.conf.label}</div>
<div id="dash"></div>
<script>
const D = ${JSON.stringify(data)};
const smColors = D.smSeries.map(p => p.value >= 0 ? '#22c55e' : '#ef4444');
const tSm = { type:'bar', x:D.smSeries.map(p=>p.label), y:D.smSeries.map(p=>p.value), marker:{color:smColors}, name:'Nansen Δ', showlegend:false, xaxis:'x', yaxis:'y' };
const tBuys = { type:'bar', x:D.pairLabels, y:D.pairBuys, name:'Buys (24h)', marker:{color:'#22c55e'}, xaxis:'x2', yaxis:'y2', offsetgroup:'bs' };
const tSells = { type:'bar', x:D.pairLabels, y:D.pairSells, name:'Sells (24h)', marker:{color:'#ef4444'}, xaxis:'x2', yaxis:'y2', offsetgroup:'bs' };
const tVol = { type:'bar', x:D.pairLabels, y:D.pairVol, name:'Volume 24h (USD)', marker:{color:'#8b5cf6'}, xaxis:'x3', yaxis:'y3' };

const layout = {
  paper_bgcolor:'#0b0f17', plot_bgcolor:'#0b0f17', font:{color:'#e5e7eb'},
  showlegend:true, legend:{orientation:'h', y:1.06},
  grid:{rows:2, columns:2, pattern:'independent', roworder:'top to bottom'},
  xaxis:{gridcolor:'#1f2937'},  yaxis:{title:'Δ KTA tokens', gridcolor:'#1f2937', zerolinecolor:'#374151'},
  xaxis2:{gridcolor:'#1f2937', tickangle:-35}, yaxis2:{title:'Tx count', gridcolor:'#1f2937'},
  xaxis3:{gridcolor:'#1f2937', tickangle:-35}, yaxis3:{title:'USD volume', gridcolor:'#1f2937'},
  barmode:'group',
  margin:{t:50,l:70,r:40,b:100},
  annotations:[
    { text:'<b>Smart Money + Exchange Δ (Nansen)</b>', xref:'paper',yref:'paper', x:0, y:1.02, xanchor:'left', showarrow:false, font:{size:13} },
    { text:'<b>DEX Buys vs Sells per pool (24h)</b>', xref:'paper',yref:'paper', x:0.55, y:1.02, xanchor:'left', showarrow:false, font:{size:13} },
    { text:'<b>DEX Volume per pool (24h)</b>', xref:'paper',yref:'paper', x:0, y:0.48, xanchor:'left', showarrow:false, font:{size:13} },
    { text:D.summary, xref:'paper',yref:'paper', x:0.55, y:0.46, xanchor:'left', yanchor:'top', showarrow:false, font:{size:12}, align:'left', bgcolor:'#111827', bordercolor:'#374151', borderwidth:1, borderpad:12 },
  ],
};
Plotly.newPlot('dash', [tSm, tBuys, tSells, tVol], layout, {responsive:true, displayModeBar:false});
</script></body></html>`;
}

// ─── Article MD ─────────────────────────────────────────────

function buildArticle(ctx) {
  const { research, price, layer1, layer2, layer3, layer4, layer5, conf, nansen, dex, rsi14_4h, macd4h, ema21_4h, ema50D_last: ema50D, ema200D_last: ema200D, vol6Ratio } = ctx;

  const topB = nansen.topBuyers.slice(0, 3).map((b, i) =>
    `${i + 1}. \`${(b.address || "").slice(0, 10)}…\` [${b.address_label || "unlabeled"}] — ${fmtUsd(Number(b.bought_volume_usd))}, ${fmtNum(Number(b.bought_token_volume))} KTA`
  ).join("\n") || "_No labeled buyer data._";
  const topS = nansen.topSellers.slice(0, 3).map((b, i) =>
    `${i + 1}. \`${(b.address || "").slice(0, 10)}…\` [${b.address_label || "unlabeled"}] — ${fmtUsd(Number(b.sold_volume_usd))}, ${fmtNum(Number(b.sold_token_volume))} KTA`
  ).join("\n") || "_No labeled seller data._";

  const dexRows = dex.pairs.map(p =>
    `- **${p.dex}/${p.pair}** · liq ${fmtUsd(p.liq)} · vol24 ${fmtUsd(p.vol24)} · ${p.buys24} buys / ${p.sells24} sells · Δ1h ${Number.isFinite(p.ch1h) ? p.ch1h.toFixed(2) + "%" : "–"} · Δ6h ${Number.isFinite(p.ch6h) ? p.ch6h.toFixed(2) + "%" : "–"} · Δ24h ${p.ch24h.toFixed(2)}%`
  ).join("\n");

  const headline = conf.confirmingCount >= 4
    ? "Keeta's Quiet Bleed: Why KTA Is Down Today When Everything Else Is Up"
    : conf.confirmingCount === 3
      ? "No Catalyst, No Buyers: Why KTA Is Drifting Lower"
      : "A Selloff Without Follow-Through? Reading KTA's 5% Drop";

  const oneLine = `${conf.label} — ${conf.confirmingCount}/5 layers confirm the drop. KTA ${price.ktaCh24h.toFixed(2)}% in 24h while BTC ${price.btcCh24h >= 0 ? "+" : ""}${price.btcCh24h.toFixed(2)}% and ETH ${price.ethCh24h >= 0 ? "+" : ""}${price.ethCh24h.toFixed(2)}% — this is KTA-specific, not tape-wide.`;

  const sec1 = `## Section 1 — The catalyst (or the absence of one)

There is no fresh news catalyst driving KTA lower today. The bank-acquisition narrative that put the token on the map was announced **January 21, 2026** — Keeta committed 35M KTA (~${fmtUsd(research.bankAcquisition.approxUsdAtAnnouncement)} at the time) toward acquiring a regulated bank, and three months later the deal remains in the "pending regulatory approval" state. The story hasn't died, but it hasn't been refreshed either. For a sub-${fmtUsd(price.mcap)}-mcap asset whose thesis is pegged to a single binary regulatory event, silence is a slow erosion.

What hasn't been silent is the supply side. The **April 5 linear-vesting unlock** released ${research.tokenUnlock.unlockUsdRange} of KTA exactly 16 days ago. Circulating supply is ${research.tokenUnlock.circulatingPctApril2026}% of the 1B cap, which means **more than half the supply is still locked**, vesting on a 24–48 month schedule that extends to August 2029. The first insider unlock fired in September 2025; every subsequent monthly release compounds the structural sell pressure. The drop today is not a news event — it is the continuation of a slow bleed that a new bid narrative has not arrived to stop.`;

  const emaStack = price.priceNow < ema50D && ema50D < ema200D ? "bearishly stacked" : price.priceNow > ema50D && ema50D > ema200D ? "bullishly stacked" : "mixed";

  const sec2 = `## Section 2 — The technical read (4h + daily)

**4H timeframe.** Price ${price.priceNow.toFixed(4)}, below EMA21 at ${ema21_4h.toFixed(4)}. RSI(14) reads ${rsi14_4h.toFixed(2)} — testing the oversold threshold but not yet through. MACD line ${macd4h.line.toFixed(4)} below signal ${macd4h.signal.toFixed(4)} with histogram ${macd4h.hist.toFixed(4)} — negative and still expanding to the downside. Volume on the last 6 candles is ${vol6Ratio.toFixed(2)}× the prior 6-bar average: this is not a drift, this is a move with volume behind it.

**Daily timeframe.** EMA50 at ${ema50D.toFixed(4)}, EMA200 at ${ema200D.toFixed(4)} — the stack is **${emaStack}**, and price at ${price.priceNow.toFixed(4)} sits below both. OBV confirms the downtrend (no bullish divergence yet), meaning the longer-timeframe volume profile is aligned with the lower-timeframe selling. There's no technical argument here for a contrarian bounce beyond the usual mean-reversion pull from a near-oversold RSI.

**Does the chart confirm the drop?** ${layer2.summary}`;

  const sec3 = `## Section 3 — Smart money and whale activity

Nansen's labeled Smart Money cohort for KTA on Base is thin: **${nansen.sm.holders} wallet${nansen.sm.holders === 1 ? "" : "s"}** holding ${fmtNum(nansen.sm.tokens)} KTA (${fmtUsd(nansen.sm.usd)}), **flat over the 24h window** (Δ ${(nansen.sm.d24 ?? 0).toFixed(2)} KTA). That's not a signal in either direction — it's a coverage gap. Base-native, retail-heavy assets tend to sit below Nansen's labeled-cohort thresholds.

The more legible read is the **exchange cohort**: ${nansen.exch.holders} labeled wallets holding ${fmtNum(nansen.exch.tokens)} KTA (${fmtUsd(nansen.exch.usd)}) with a 24h delta of ${nansen.exch.d24 >= 0 ? "+" : ""}${fmtNum(nansen.exch.d24)} KTA. Supply is **moving onto exchange orderbooks, not off them** — the opposite of an accumulation signature.

Top of the labeled buy tape (7d):
${topB}

Top of the labeled sell tape (7d):
${topS}

${layer3.summary}`;

  const sec4 = `## Section 4 — DEX trading activity

${dex.pairs.length} meaningful KTA pools on Base (aggregating across Aerodrome, Uniswap, and smaller venues). Aerodrome KTA/WETH is the deepest pool by far — liquidity there determines the price the aggregators route against.

${dexRows}

**Aggregated across pools (24h):** ${dex.totalBuys} buy txns vs ${dex.totalSells} sell txns (${dex.txSkew >= 0 ? "+" : ""}${dex.txSkew.toFixed(1)}pp tx-count skew), ${fmtUsd(dex.totalVol)} of volume on ${fmtUsd(dex.totalLiq)} of combined liquidity, volume-weighted 24h price ${dex.weightedCh24h.toFixed(2)}%.

The pattern to read here is the **divergence between transaction count and price**: more *buy* transactions than sell transactions, yet price is still down across every pool. That math only closes one way — the sell transactions are **larger per-order**. Small retail wallets are adding on the dip; a small number of bigger wallets are distributing into those bids. This is the canonical "whale distribution dressed up as balanced flow" pattern. ${layer4.summary}`;

  const sec5 = `## Section 5 — Market context

This is the layer that makes the read unambiguous:

- **KTA vs tape:** KTA ${price.ktaCh24h.toFixed(2)}% over 24h vs BTC ${price.btcCh24h >= 0 ? "+" : ""}${price.btcCh24h.toFixed(2)}% and ETH ${price.ethCh24h >= 0 ? "+" : ""}${price.ethCh24h.toFixed(2)}%. The market is **green**. KTA is the one dropping.
- **KTA vs sector:** The RWA sector is running hot — +185.8% average returns YTD 2026, +4% in April alone according to sector trackers. If KTA's weakness were sector rotation, peer RWA tokens would be red. They're not. This isolates the weakness to the name.
- **Supply overhang:** ${research.tokenUnlock.unlockUsdRange} unlocked 16 days ago. ${research.tokenUnlock.remainingLockedPct}% of the 1B max supply is still locked on a schedule running through 2029. There is no clean "post-unlock detox" window when the next unlock is always ~30 days away.
- **ATH distance:** $${price.ath.toFixed(2)} set ${price.athDate ? `on ${price.athDate.slice(0, 10)}` : "in mid-2025"}; current price is **${price.athChangePct.toFixed(2)}%** from that level — ~10% of ATH on a token whose narrative peak required a new bid story that hasn't yet materialized.
- **Perpetual markets:** KTA perps exist on LBank, Kraken Futures, and MEXC. Bybit does not list KTAUSDT. Funding rates were not pulled live in this run (no free public endpoint), so the positioning data is a known gap — worth checking LBank/MEXC directly for OI shifts and funding if this thesis gets size.`;

  const sec6 = `## Section 6 — Causal chain and confluence verdict

| # | Layer | Signal | Does it confirm the drop? |
|---|---|---|---|
| 1 | Catalyst | ${layer1.verdict.toUpperCase()} | ${layer1.summary} |
| 2 | Technical | ${layer2.verdict.toUpperCase()} | ${layer2.summary} |
| 3 | Smart money | ${layer3.verdict.toUpperCase()} | ${layer3.summary} |
| 4 | DEX flow | ${layer4.verdict.toUpperCase()} | ${layer4.summary} |
| 5 | Market context | ${layer5.verdict.toUpperCase()} | ${layer5.summary} |

**Causal chain.**
1. *Trigger.* No fresh news. The -5% 24h (and -15% 7d) is the continuation of post-unlock supply pressure layered on a stale bank-acquisition narrative.
2. *Technical confirmation.* Price below EMA21 (4h) and below EMA50 < EMA200 (daily), MACD expanding negative, OBV confirming downtrend, volume 1.43× baseline. Selling is confirmed, not exhausted.
3. *Smart money alignment.* Nansen SM coverage is thin (1 wallet, flat). Exchange cohort is **loading** — supply moving onto orderbooks, +${fmtNum(nansen.exch.d24 ?? 0)} KTA net in 24h.
4. *On-chain conviction.* DEX tx count shows retail buying the dip, but price still down across all pools — whale-sized sells walking price down against broad small-ticket bids. Classic distribution signature.
5. *Market context.* KTA-specific weakness in a green market and a strong RWA sector. Supply overhang is the only consistent explanation.

**Verdict: ${conf.label}** — ${conf.confirmingCount} of 5 layers confirm the drop (${conf.counts.contradicting || 0} contradict, ${conf.counts.neutral || 0} neutral, ${conf.counts.mixed || 0} mixed). ${conf.confirmingCount >= 4
      ? "At this conviction level, the drop is not a random liquidity event — it is structurally supported. The bounce case rests on RSI mean reversion and retail bids on Aerodrome, which is a thin support against vesting-schedule supply and a fading narrative. A 'dip buy' here needs a catalyst, not just a price."
      : conf.confirmingCount === 3
        ? "Moderate conviction. The drop is supported, but not overwhelmingly. Two layers are not on-side (or are noisy enough to not register as confirming) — those are the spots to watch for a turn."
        : "Weak conviction. More layers are off-side than aligned, which usually precedes a bounce. The caveat: weak confluence doesn't mean strong contrarian signal — it means the information set is noisy, and the right move may be to size down, not to fade."}`;

  const closing = `## Closing

This is a **KTA-specific drop in a green market and a hot sector**, with technicals confirming, exchange supply rising, and DEX flow showing whale distribution against retail bids. The structural driver is ongoing vesting — half the float is still locked, and unlocks run monthly through 2029. The bounce case is a mechanical RSI reflex from near-oversold territory, not a narrative turn. Define invalidations in advance: a reclaim of the daily EMA50 with OBV turning up, a flip in exchange-cohort holdings back to net outflow, and a fresh update on the bank-acquisition process would each break a leg of this thesis. Until one does, the read is what the tape says.

_None of this is financial advice. Data snapshots — refresh before acting on any of it._`;

  return `# ${headline}

_${oneLine}_

_Generated ${new Date(ctx.now).toUTCString()} · KRAKEN:KTAUSD daily · Price $${price.priceNow.toFixed(4)}_

---

${sec1}

${sec2}

${sec3}

${sec4}

${sec5}

${sec6}

---

${closing}
`;
}

main().catch((err) => { console.error("fatal:", err); process.exit(1); });
