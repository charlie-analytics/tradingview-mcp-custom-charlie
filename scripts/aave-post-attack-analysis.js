#!/usr/bin/env node

/**
 * aave-post-attack-analysis.js
 *
 * Three-layer confluence read on AAVE:
 *   Layer 1 — TradingView (via `tv` CLI): OHLCV on the live AAVEUSDT daily chart,
 *             with EMA50/EMA200, RSI(14), and OBV computed in-script from bars.
 *   Layer 2 — Nansen (REST): smart-money holdings delta + exchange holdings delta
 *             for AAVE on Ethereum.
 *   Layer 3 — DexScreener (free REST): aggregated AAVE/WETH and AAVE/USDC pairs
 *             on Ethereum DEXes (there's no material AAVE/USDT on Ethereum).
 *
 * Writes two files to ~/Desktop:
 *   - AAVE_SmartMoney_Analysis.html  (Plotly dashboard, 4 panels)
 *   - AAVE_SmartMoney_Article.md     (editorial analysis article)
 *
 * Usage: node scripts/aave-post-attack-analysis.js
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
const AAVE_ETH = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";

// ───────────────────────── env + http helpers ─────────────────────────

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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
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
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return r.ok ? { ok: true, data } : { ok: false, status: r.status, error: data };
}

async function dexScreener(path) {
  const r = await fetch(`${DEXS_BASE}${path}`);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, data: await r.json() };
}

function tvCli(...args) {
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
  if (Array.isArray(resp.data.rows)) return resp.data.rows;
  return [];
}

function endpoints(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [null, null];
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return [sorted[0], sorted[sorted.length - 1]];
}

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 86400_000).toISOString().slice(0, 19) + "Z";
}
const isoNow = () => new Date().toISOString().slice(0, 19) + "Z";

// ───────────────────────── indicator math ─────────────────────────

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
  let gSum = 0;
  let lSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gSum += d;
    else lSum -= d;
  }
  let avgG = gSum / period;
  let avgL = lSum / period;
  out[period] = 100 - 100 / (1 + avgG / (avgL || 1e-10));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-10));
  }
  return out;
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

// Least-squares slope over last N points, normalized by mean (so slopes are comparable across series with different magnitudes)
function normSlope(arr, window = 14) {
  const n = Math.min(window, arr.length);
  if (n < 3) return 0;
  const sub = arr.slice(-n);
  const xMean = (n - 1) / 2;
  const yMean = sub.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (sub[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = num / den;
  const scale = Math.abs(yMean) || 1;
  return slope / scale;
}

// ───────────────────────── scoring ─────────────────────────

function scoreChart({ price, ema50, ema200, rsiNow, priceSlope, obvSlope }) {
  const reasons = [];
  let score = 0;

  const emaStack = price > ema50 && ema50 > ema200;
  const emaStackDown = price < ema50 && ema50 < ema200;
  if (emaStack) {
    score += 1;
    reasons.push("price above EMA50 above EMA200 (trend up)");
  } else if (emaStackDown) {
    score -= 1;
    reasons.push("price below EMA50 below EMA200 (trend down)");
  } else {
    reasons.push(
      `EMA structure mixed (price ${price.toFixed(2)} vs EMA50 ${ema50.toFixed(2)} vs EMA200 ${ema200.toFixed(2)})`,
    );
  }

  if (rsiNow < 30) {
    score += 0.5;
    reasons.push(`RSI ${rsiNow.toFixed(1)} oversold (mean-revert setup)`);
  } else if (rsiNow > 70) {
    score -= 0.5;
    reasons.push(`RSI ${rsiNow.toFixed(1)} overbought`);
  } else {
    reasons.push(`RSI ${rsiNow.toFixed(1)} neutral`);
  }

  const diverge =
    priceSlope > 0 && obvSlope < -0.001
      ? "bearish"
      : priceSlope < 0 && obvSlope > 0.001
        ? "bullish"
        : null;
  if (diverge === "bullish") {
    score += 1;
    reasons.push("OBV rising while price falling — bullish divergence (hidden accumulation)");
  } else if (diverge === "bearish") {
    score -= 1;
    reasons.push("OBV falling while price rising — bearish divergence (distribution)");
  } else if (priceSlope > 0 && obvSlope > 0) {
    reasons.push("OBV confirms uptrend");
  } else if (priceSlope < 0 && obvSlope < 0) {
    reasons.push("OBV confirms downtrend");
    score -= 0.25;
  } else {
    reasons.push("OBV flat relative to price");
  }

  const verdict = score >= 0.75 ? "bullish" : score <= -0.75 ? "bearish" : "neutral";
  return { verdict, score, reasons, diverge };
}

function scoreNansen({ smDelta, exchDelta }) {
  const reasons = [];
  let score = 0;
  if (smDelta != null) {
    if (smDelta > 0) {
      score += 1;
      reasons.push(`smart money added ${smDelta.toFixed(2)} AAVE (24h)`);
    } else if (smDelta < 0) {
      score -= 1;
      reasons.push(`smart money shed ${Math.abs(smDelta).toFixed(2)} AAVE (24h)`);
    } else {
      reasons.push("smart money holdings flat");
    }
  }
  if (exchDelta != null) {
    if (exchDelta < 0) {
      score += 1;
      reasons.push(`exchanges lost ${Math.abs(exchDelta).toFixed(2)} AAVE (supply off orderbooks)`);
    } else if (exchDelta > 0) {
      score -= 1;
      reasons.push(`exchanges gained ${exchDelta.toFixed(2)} AAVE (supply being added to orderbooks)`);
    } else {
      reasons.push("exchange holdings flat");
    }
  }
  const verdict = score >= 1 ? "bullish" : score <= -1 ? "bearish" : "neutral";
  return { verdict, score, reasons };
}

function scoreDex(pairsAgg) {
  const reasons = [];
  let score = 0;
  for (const [label, agg] of Object.entries(pairsAgg)) {
    if (!agg) continue;
    const total = agg.buys + agg.sells;
    if (total === 0) continue;
    const buyPct = (agg.buys / total) * 100;
    const skew = buyPct - 50;
    if (skew > 10) {
      score += 0.5;
      reasons.push(`${label}: buy skew +${skew.toFixed(1)}pp (${agg.buys} buys / ${agg.sells} sells)`);
    } else if (skew < -10) {
      score -= 0.5;
      reasons.push(`${label}: sell skew ${skew.toFixed(1)}pp (${agg.buys} buys / ${agg.sells} sells)`);
    } else {
      reasons.push(`${label}: balanced (${agg.buys} buys / ${agg.sells} sells, ${buyPct.toFixed(0)}% buy)`);
    }
    if (agg.priceChange24h > 2) {
      score += 0.25;
    } else if (agg.priceChange24h < -2) {
      score -= 0.25;
    }
  }
  const verdict = score >= 0.5 ? "bullish" : score <= -0.5 ? "bearish" : "neutral";
  return { verdict, score, reasons };
}

function confluenceVerdict(chart, nansen, dex) {
  const verdicts = [chart.verdict, nansen.verdict, dex.verdict];
  const bull = verdicts.filter((v) => v === "bullish").length;
  const bear = verdicts.filter((v) => v === "bearish").length;
  const neu = verdicts.filter((v) => v === "neutral").length;
  if (bull === 3) return { label: "ALIGNED BULLISH", strength: "strong", bull, bear, neu };
  if (bear === 3) return { label: "ALIGNED BEARISH", strength: "strong", bull, bear, neu };
  if (bull === 2 && bear === 0) return { label: "LEANING BULLISH", strength: "moderate", bull, bear, neu };
  if (bear === 2 && bull === 0) return { label: "LEANING BEARISH", strength: "moderate", bull, bear, neu };
  if (bull > 0 && bear > 0) return { label: "CONFLICTING", strength: "split", bull, bear, neu };
  return { label: "NEUTRAL", strength: "no edge", bull, bear, neu };
}

// ───────────────────────── dex aggregation ─────────────────────────

function aggregatePairs(rawPairs, quoteSymbol) {
  const filtered = rawPairs.filter(
    (p) => p.chainId === "ethereum" && p.quoteToken?.symbol === quoteSymbol,
  );
  if (filtered.length === 0) return null;
  let liq = 0;
  let vol = 0;
  let buys = 0;
  let sells = 0;
  let weightedChange = 0;
  let weight = 0;
  const dexes = new Set();
  for (const p of filtered) {
    const l = Number(p.liquidity?.usd) || 0;
    const v = Number(p.volume?.h24) || 0;
    const b = Number(p.txns?.h24?.buys) || 0;
    const s = Number(p.txns?.h24?.sells) || 0;
    const c = Number(p.priceChange?.h24);
    liq += l;
    vol += v;
    buys += b;
    sells += s;
    if (!Number.isNaN(c)) {
      weightedChange += c * v;
      weight += v;
    }
    if (p.dexId) dexes.add(p.dexId);
  }
  return {
    quoteSymbol,
    pairCount: filtered.length,
    dexes: [...dexes],
    liquidityUsd: liq,
    volume24hUsd: vol,
    buys,
    sells,
    priceChange24h: weight > 0 ? weightedChange / weight : 0,
  };
}

// ───────────────────────── main ─────────────────────────

async function main() {
  loadDotEnv();
  if (!process.env.NANSEN_API_KEY) {
    console.error("NANSEN_API_KEY missing. Add it to .env.");
    process.exit(1);
  }

  console.log("→ layer 1: pulling AAVE daily bars from TradingView…");
  const ohlcv = tvCli("ohlcv", "-n", "250");
  const state = tvCli("state");
  const quote = tvCli("quote");
  if (!ohlcv?.bars || ohlcv.bars.length < 60) {
    console.error("OHLCV pull failed or too few bars:", ohlcv?.error || "no bars");
    process.exit(1);
  }
  const bars = ohlcv.bars;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const obvSeries = obv(closes, volumes);
  const priceNow = closes.at(-1);
  const ema50Now = ema50.at(-1);
  const ema200Now = ema200.at(-1);
  const rsiNow = rsi14.at(-1);
  const priceSlope14 = normSlope(closes, 14);
  const obvSlope14 = normSlope(obvSeries, 14);

  const chart = scoreChart({
    price: priceNow,
    ema50: ema50Now,
    ema200: ema200Now,
    rsiNow,
    priceSlope: priceSlope14,
    obvSlope: obvSlope14,
  });

  console.log("→ layer 2: pulling AAVE flow from Nansen…");
  const nowIso = isoNow();
  const [smFlow24, exchFlow24, smFlow7d, exchFlow7d, topBuyers, topSellers] = await Promise.all([
    nansen("/tgm/flows", {
      chain: "ethereum",
      token_address: AAVE_ETH,
      date: { from: isoDaysAgo(1), to: nowIso },
      label: "smart_money",
      pagination: { page: 1, per_page: 200 },
    }),
    nansen("/tgm/flows", {
      chain: "ethereum",
      token_address: AAVE_ETH,
      date: { from: isoDaysAgo(1), to: nowIso },
      label: "exchange",
      pagination: { page: 1, per_page: 200 },
    }),
    nansen("/tgm/flows", {
      chain: "ethereum",
      token_address: AAVE_ETH,
      date: { from: isoDaysAgo(7), to: nowIso },
      label: "smart_money",
      pagination: { page: 1, per_page: 200 },
    }),
    nansen("/tgm/flows", {
      chain: "ethereum",
      token_address: AAVE_ETH,
      date: { from: isoDaysAgo(7), to: nowIso },
      label: "exchange",
      pagination: { page: 1, per_page: 200 },
    }),
    nansen("/tgm/who-bought-sold", {
      chain: "ethereum",
      token_address: AAVE_ETH,
      buy_or_sell: "BUY",
      date: { from: isoDaysAgo(7), to: nowIso },
      pagination: { page: 1, per_page: 10 },
      order_by: [{ field: "bought_volume_usd", direction: "DESC" }],
    }),
    nansen("/tgm/who-bought-sold", {
      chain: "ethereum",
      token_address: AAVE_ETH,
      buy_or_sell: "SELL",
      date: { from: isoDaysAgo(7), to: nowIso },
      pagination: { page: 1, per_page: 10 },
      order_by: [{ field: "sold_volume_usd", direction: "DESC" }],
    }),
  ]);

  function delta(flowResp) {
    const [old, nw] = endpoints(rowsFrom(flowResp));
    if (!old || !nw) return null;
    return Number(nw.token_amount) - Number(old.token_amount);
  }
  function holdings(flowResp) {
    const [old, nw] = endpoints(rowsFrom(flowResp));
    return {
      start: old ? Number(old.token_amount) : null,
      end: nw ? Number(nw.token_amount) : null,
      holdersStart: old ? Number(old.holders_count) : null,
      holdersEnd: nw ? Number(nw.holders_count) : null,
    };
  }
  const smDelta24 = delta(smFlow24);
  const exchDelta24 = delta(exchFlow24);
  const smDelta7 = delta(smFlow7d);
  const exchDelta7 = delta(exchFlow7d);
  const smHold24 = holdings(smFlow24);
  const exchHold24 = holdings(exchFlow24);
  const nansenScore = scoreNansen({ smDelta: smDelta24, exchDelta: exchDelta24 });

  console.log("→ layer 3: pulling AAVE DEX pairs from DexScreener…");
  const dexResp = await dexScreener(`/tokens/${AAVE_ETH}`);
  const rawPairs = dexResp?.data?.pairs || [];
  const aggWETH = aggregatePairs(rawPairs, "WETH");
  const aggUSDC = aggregatePairs(rawPairs, "USDC");
  const dexAgg = { "AAVE/WETH": aggWETH, "AAVE/USDC": aggUSDC };
  const dexScore = scoreDex(dexAgg);

  const conf = confluenceVerdict(chart, nansenScore, dexScore);

  // Print report to console
  console.log(`\n${"═".repeat(60)}`);
  console.log("  AAVE POST-ATTACK THREE-LAYER READ");
  console.log("═".repeat(60));
  console.log(`\n[CHART]   verdict: ${chart.verdict.toUpperCase()}`);
  console.log(`  price ${priceNow.toFixed(2)} | EMA50 ${ema50Now.toFixed(2)} | EMA200 ${ema200Now.toFixed(2)} | RSI ${rsiNow.toFixed(1)}`);
  for (const r of chart.reasons) console.log(`  • ${r}`);

  console.log(`\n[NANSEN]  verdict: ${nansenScore.verdict.toUpperCase()}`);
  console.log(`  SM 24h  : ${smHold24.start?.toFixed(2)} → ${smHold24.end?.toFixed(2)} AAVE  (Δ ${(smDelta24 ?? 0).toFixed(2)})`);
  console.log(`  EXCH 24h: ${exchHold24.start?.toFixed(2)} → ${exchHold24.end?.toFixed(2)} AAVE  (Δ ${(exchDelta24 ?? 0).toFixed(2)})`);
  console.log(`  SM 7d Δ : ${(smDelta7 ?? 0).toFixed(2)} AAVE   EXCH 7d Δ: ${(exchDelta7 ?? 0).toFixed(2)} AAVE`);
  for (const r of nansenScore.reasons) console.log(`  • ${r}`);

  console.log(`\n[DEX]     verdict: ${dexScore.verdict.toUpperCase()}`);
  for (const [k, v] of Object.entries(dexAgg)) {
    if (!v) {
      console.log(`  ${k}: no pairs found`);
      continue;
    }
    console.log(
      `  ${k}: liq $${fmtUsd(v.liquidityUsd)} | vol24 $${fmtUsd(v.volume24hUsd)} | ${v.buys} buys / ${v.sells} sells | Δ24h ${v.priceChange24h.toFixed(2)}%`,
    );
  }
  for (const r of dexScore.reasons) console.log(`  • ${r}`);

  console.log(`\n[CONFLUENCE] ${conf.label} (${conf.strength})`);
  console.log(`  chart ${chart.verdict} | nansen ${nansenScore.verdict} | dex ${dexScore.verdict}`);

  // Write artifacts
  const ctx = {
    now: new Date().toISOString(),
    symbol: state?.symbol || "BINANCE:AAVEUSDT",
    tf: state?.resolution || "1D",
    bars,
    closes,
    volumes,
    ema50,
    ema200,
    rsi14,
    obvSeries,
    priceNow,
    ema50Now,
    ema200Now,
    rsiNow,
    priceSlope14,
    obvSlope14,
    chart,
    nansen: {
      smDelta24,
      exchDelta24,
      smDelta7,
      exchDelta7,
      smHold24,
      exchHold24,
      topBuyers: rowsFrom(topBuyers).slice(0, 5),
      topSellers: rowsFrom(topSellers).slice(0, 5),
      verdict: nansenScore.verdict,
      reasons: nansenScore.reasons,
    },
    dex: { verdict: dexScore.verdict, reasons: dexScore.reasons, pairs: dexAgg },
    conf,
  };

  console.log("\n→ writing Plotly dashboard + article to Desktop…");
  const htmlPath = resolve(DESKTOP, "AAVE_SmartMoney_Analysis.html");
  writeFileSync(htmlPath, buildHtml(ctx));
  const mdPath = resolve(DESKTOP, "AAVE_SmartMoney_Article.md");
  writeFileSync(mdPath, buildArticle(ctx));
  console.log(`  ✓ ${htmlPath}`);
  console.log(`  ✓ ${mdPath}`);
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(0);
}

// ───────────────────────── Plotly HTML ─────────────────────────

function buildHtml(ctx) {
  const display = ctx.bars.slice(-120);
  const dates = display.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10));
  const open = display.map((b) => b.open);
  const high = display.map((b) => b.high);
  const low = display.map((b) => b.low);
  const close = display.map((b) => b.close);
  const ema50Slice = ctx.ema50.slice(-120);
  const ema200Slice = ctx.ema200.slice(-120);

  const smSeries = [
    { label: "Smart Money Δ 24h", value: ctx.nansen.smDelta24 ?? 0 },
    { label: "Smart Money Δ 7d", value: ctx.nansen.smDelta7 ?? 0 },
    { label: "Exchange Δ 24h (inverted bias)", value: -(ctx.nansen.exchDelta24 ?? 0) },
    { label: "Exchange Δ 7d (inverted bias)", value: -(ctx.nansen.exchDelta7 ?? 0) },
  ];

  const dexRows = Object.entries(ctx.dex.pairs).filter(([, v]) => v);
  const dexLabels = dexRows.map(([k]) => k);
  const dexVols = dexRows.map(([, v]) => v.volume24hUsd);
  const dexBuys = dexRows.map(([, v]) => v.buys);
  const dexSells = dexRows.map(([, v]) => v.sells);

  const summary = [
    `Chart: ${ctx.chart.verdict.toUpperCase()}`,
    `Smart Money: ${ctx.nansen.verdict.toUpperCase()}`,
    `DEX: ${ctx.dex.verdict.toUpperCase()}`,
    ``,
    `Confluence: ${ctx.conf.label}`,
    ``,
    `Price ${ctx.priceNow.toFixed(2)} | EMA50 ${ctx.ema50Now.toFixed(2)} | EMA200 ${ctx.ema200Now.toFixed(2)} | RSI ${ctx.rsiNow.toFixed(1)}`,
  ].join("<br>");

  const data = {
    dates,
    open,
    high,
    low,
    close,
    ema50: ema50Slice,
    ema200: ema200Slice,
    smSeries,
    dexLabels,
    dexVols,
    dexBuys,
    dexSells,
    summary,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AAVE Smart Money Analysis</title>
<script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
<style>
  body { background: #0b0f17; color: #e5e7eb; font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 16px; }
  h1 { font-weight: 600; margin: 4px 0 12px; font-size: 20px; }
  .sub { color: #9ca3af; font-size: 13px; margin-bottom: 16px; }
  #dash { height: calc(100vh - 80px); }
</style>
</head>
<body>
<h1>AAVE Three-Layer Read — ${ctx.symbol} ${ctx.tf}</h1>
<div class="sub">Generated ${new Date(ctx.now).toLocaleString()} · Price $${ctx.priceNow.toFixed(2)} · Confluence: <strong>${ctx.conf.label}</strong></div>
<div id="dash"></div>
<script>
const D = ${JSON.stringify(data)};

const traceCandle = {
  type: 'candlestick',
  x: D.dates, open: D.open, high: D.high, low: D.low, close: D.close,
  name: 'AAVE/USDT',
  increasing: { line: { color: '#22c55e' } },
  decreasing: { line: { color: '#ef4444' } },
  xaxis: 'x', yaxis: 'y',
};
const traceEma50 = { type: 'scatter', mode: 'lines', x: D.dates, y: D.ema50, name: 'EMA 50', line: { color: '#60a5fa', width: 1.5 }, xaxis: 'x', yaxis: 'y' };
const traceEma200 = { type: 'scatter', mode: 'lines', x: D.dates, y: D.ema200, name: 'EMA 200', line: { color: '#f59e0b', width: 1.5 }, xaxis: 'x', yaxis: 'y' };

const smColors = D.smSeries.map(p => p.value >= 0 ? '#22c55e' : '#ef4444');
const traceSm = {
  type: 'bar',
  x: D.smSeries.map(p => p.label),
  y: D.smSeries.map(p => p.value),
  marker: { color: smColors },
  name: 'Nansen Δ AAVE',
  xaxis: 'x2', yaxis: 'y2',
  showlegend: false,
};

const traceDexVol = {
  type: 'bar',
  x: D.dexLabels, y: D.dexVols,
  name: '24h Volume (USD)',
  marker: { color: '#8b5cf6' },
  xaxis: 'x3', yaxis: 'y3',
};
const traceDexBuys = {
  type: 'bar',
  x: D.dexLabels, y: D.dexBuys,
  name: 'Buys (24h)',
  marker: { color: '#22c55e' },
  xaxis: 'x3', yaxis: 'y4',
  offsetgroup: 'buysell',
};
const traceDexSells = {
  type: 'bar',
  x: D.dexLabels, y: D.dexSells,
  name: 'Sells (24h)',
  marker: { color: '#ef4444' },
  xaxis: 'x3', yaxis: 'y4',
  offsetgroup: 'buysell',
};

const layout = {
  paper_bgcolor: '#0b0f17',
  plot_bgcolor: '#0b0f17',
  font: { color: '#e5e7eb' },
  showlegend: true,
  legend: { orientation: 'h', y: 1.04 },
  grid: { rows: 2, columns: 2, pattern: 'independent', roworder: 'top to bottom' },
  xaxis:  { title: '', gridcolor: '#1f2937' },
  yaxis:  { title: 'Price (USDT)', gridcolor: '#1f2937' },
  xaxis2: { title: '', gridcolor: '#1f2937' },
  yaxis2: { title: 'Δ AAVE', gridcolor: '#1f2937', zerolinecolor: '#374151' },
  xaxis3: { title: '', gridcolor: '#1f2937' },
  yaxis3: { title: '24h Volume (USD)', gridcolor: '#1f2937' },
  yaxis4: { title: 'Tx count', overlaying: 'y3', side: 'right', gridcolor: '#1f2937' },
  margin: { t: 50, l: 60, r: 60, b: 50 },
  annotations: [
    { text: '<b>Chart — Price + EMA50 / EMA200</b>', xref: 'paper', yref: 'paper', x: 0.0, y: 1.00, xanchor: 'left', showarrow: false, font: { size: 13 } },
    { text: '<b>Smart Money + Exchange Δ (Nansen)</b>', xref: 'paper', yref: 'paper', x: 0.55, y: 1.00, xanchor: 'left', showarrow: false, font: { size: 13 } },
    { text: '<b>DEX Volume + Buys/Sells</b>', xref: 'paper', yref: 'paper', x: 0.0, y: 0.45, xanchor: 'left', showarrow: false, font: { size: 13 } },
    { text: '<b>Confluence Verdict</b><br><br>' + D.summary, xref: 'paper', yref: 'paper', x: 0.55, y: 0.45, xanchor: 'left', yanchor: 'top', showarrow: false, font: { size: 13 }, align: 'left', bgcolor: '#111827', bordercolor: '#374151', borderwidth: 1, borderpad: 12 },
  ],
  xaxis4: { visible: false },
};

// Hide the 4th subplot's axes — we draw the verdict as an annotation over empty space
Plotly.newPlot('dash', [traceCandle, traceEma50, traceEma200, traceSm, traceDexVol, traceDexBuys, traceDexSells], layout, { responsive: true, displayModeBar: false });
</script>
</body>
</html>`;
}

// ───────────────────────── Article MD ─────────────────────────

function buildArticle(ctx) {
  const { priceNow, ema50Now, ema200Now, rsiNow, priceSlope14, obvSlope14, chart, nansen, dex, conf } = ctx;
  const emaStack =
    priceNow > ema50Now && ema50Now > ema200Now
      ? "bullishly stacked"
      : priceNow < ema50Now && ema50Now < ema200Now
        ? "bearishly stacked"
        : "mixed";
  const divergeLine = chart.diverge === "bullish"
    ? "OBV is climbing while price is still under pressure — a textbook bullish divergence, the kind that shows up when supply is quietly being absorbed."
    : chart.diverge === "bearish"
      ? "OBV is fading while price holds up — a bearish divergence that says the bid isn't as deep as the tape suggests."
      : priceSlope14 < 0 && obvSlope14 < 0
        ? "OBV is confirming the downtrend — this is a trend move, not a liquidity-driven wick."
        : priceSlope14 > 0 && obvSlope14 > 0
          ? "OBV is confirming the uptrend — volume is moving with price, not against it."
          : "OBV is noncommittal — no clean divergence in either direction.";

  const smLine = nansen.smDelta24 == null
    ? "Nansen's smart-money cohort holdings for AAVE are currently unavailable on this tier."
    : nansen.smDelta24 > 0
      ? `Nansen's smart-money cohort added ${nansen.smDelta24.toFixed(2)} AAVE over the last 24 hours (${nansen.smHold24.start?.toFixed(2)} → ${nansen.smHold24.end?.toFixed(2)})`
      : nansen.smDelta24 < 0
        ? `Nansen's smart-money cohort reduced holdings by ${Math.abs(nansen.smDelta24).toFixed(2)} AAVE over the last 24 hours (${nansen.smHold24.start?.toFixed(2)} → ${nansen.smHold24.end?.toFixed(2)})`
        : `Nansen's smart-money holdings were flat over 24h at ${nansen.smHold24.end?.toFixed(2)} AAVE`;
  const sm7dLine = nansen.smDelta7 == null
    ? ""
    : nansen.smDelta7 > 0
      ? `. Over the full 7-day post-incident window the cohort is net +${nansen.smDelta7.toFixed(2)} AAVE.`
      : nansen.smDelta7 < 0
        ? `. Over the full 7-day post-incident window the cohort is net ${nansen.smDelta7.toFixed(2)} AAVE (distributing).`
        : "";

  const exchLine = nansen.exchDelta24 == null
    ? ""
    : nansen.exchDelta24 < 0
      ? `Labeled exchange wallets lost ${Math.abs(nansen.exchDelta24).toFixed(2)} AAVE in 24h — supply is being pulled *off* orderbooks, which usually fits an accumulation narrative.`
      : nansen.exchDelta24 > 0
        ? `Labeled exchange wallets took in ${nansen.exchDelta24.toFixed(2)} AAVE in 24h — supply is moving *onto* orderbooks, which typically precedes distribution.`
        : `Exchange holdings were flat over 24h.`;

  const topBuyers = nansen.topBuyers.length
    ? nansen.topBuyers.slice(0, 3).map((b, i) => `${i + 1}. \`${(b.address || "").slice(0, 10)}…\` [${b.address_label || "unlabeled"}] — $${fmtUsd(Number(b.bought_volume_usd))}, ${Number(b.bought_token_volume).toFixed(2)} AAVE`).join("\n")
    : "_No labeled buyer data returned._";
  const topSellers = nansen.topSellers.length
    ? nansen.topSellers.slice(0, 3).map((b, i) => `${i + 1}. \`${(b.address || "").slice(0, 10)}…\` [${b.address_label || "unlabeled"}] — $${fmtUsd(Number(b.sold_volume_usd))}, ${Number(b.sold_token_volume).toFixed(2)} AAVE`).join("\n")
    : "_No labeled seller data returned._";

  const dexLines = Object.entries(dex.pairs)
    .filter(([, v]) => v)
    .map(([k, v]) => {
      const total = v.buys + v.sells;
      const pct = total ? (v.buys / total) * 100 : 0;
      return `- **${k}** (${v.dexes.join(", ")}, ${v.pairCount} pool${v.pairCount > 1 ? "s" : ""}): liquidity $${fmtUsd(v.liquidityUsd)}, 24h volume $${fmtUsd(v.volume24hUsd)}, ${v.buys} buys vs ${v.sells} sells (${pct.toFixed(0)}% buy skew), 24h change ${v.priceChange24h.toFixed(2)}%.`;
    })
    .join("\n");

  const totalBuys = Object.values(dex.pairs).reduce((a, v) => a + (v?.buys || 0), 0);
  const totalSells = Object.values(dex.pairs).reduce((a, v) => a + (v?.sells || 0), 0);
  const txnSkew = totalBuys + totalSells ? ((totalBuys / (totalBuys + totalSells)) * 100).toFixed(1) : "n/a";
  const totalLiq = Object.values(dex.pairs).reduce((a, v) => a + (v?.liquidityUsd || 0), 0);
  const totalVol = Object.values(dex.pairs).reduce((a, v) => a + (v?.volume24hUsd || 0), 0);

  const headlineMap = {
    "ALIGNED BULLISH": "Whales Quietly Loading the Bid: Why AAVE's Post-Attack Tape Is Starting to Rhyme With Accumulation",
    "ALIGNED BEARISH": "No Floor Yet: Chart, Wallets, and DEX Flow All Point the Same Direction on AAVE",
    "LEANING BULLISH": "The Chart Looks Shaky, But the Wallets Disagree — AAVE's Post-Attack Read",
    "LEANING BEARISH": "A Bounce That Isn't Being Bought: AAVE's Three-Layer Read Post-Attack",
    CONFLICTING: "Mixed Signals: Reading AAVE When the Chart, the Wallets, and the DEXes Don't Agree",
    NEUTRAL: "Waiting for a Decision: AAVE Sits in No-Man's-Land Across All Three Layers",
  };
  const headline = headlineMap[conf.label] || headlineMap.NEUTRAL;
  const oneLine = `Three-layer read — chart ${chart.verdict}, smart money ${nansen.verdict}, DEX flow ${dex.verdict} — converges on **${conf.label}** (${conf.strength}).`;

  const section1 = `## Section 1 — What the chart says

AAVE is printing **$${priceNow.toFixed(2)}** on the daily, with EMA50 at **$${ema50Now.toFixed(2)}** and EMA200 at **$${ema200Now.toFixed(2)}** — the moving-average stack is currently **${emaStack}**. RSI(14) reads **${rsiNow.toFixed(1)}**${rsiNow < 30 ? ", deep in oversold territory — the kind of reading that precedes a mean-revert bounce but doesn't guarantee one" : rsiNow > 70 ? ", in overbought territory — warning signal for late longs" : ", in the middle zone where neither bulls nor bears own the tape yet"}.

The post-attack context matters here. The drawdown was not a slow grind — it was a liquidation-style repricing that left price well below the trend, dragged the EMA50 down, and opened a gap between spot and the longer-term EMA200. Whenever a name takes that kind of hit, the question isn't whether the first bounce happens — it usually does — but whether volume confirms. ${divergeLine}

This sets up a simple technical framing: reclaim and hold the EMA50 on rising OBV, and the post-incident low starts to look like a swing low. Fail at EMA50 with OBV rolling over, and the market is telling you the first bounce was liquidity, not conviction.`;

  const section2 = `## Section 2 — What smart money is doing

${smLine}${sm7dLine} ${exchLine}

Zooming into the labeled-wallet tape on Ethereum over the last 7 days, here's the top of the book:

**Top buyers**
${topBuyers}

**Top sellers**
${topSellers}

This is how you tell the difference between panic and positioning. If the top of the buy-side tape is dominated by trading-desk bots and market-makers while the sell-side is full of long-term holders, it's a distribution signal dressed up as stability. If the inverse — MMs selling into retail panic while longer-horizon wallets accumulate — it's a post-capitulation setup worth watching. Read the labels above in that frame, not in isolation.`;

  const section3 = `## Section 3 — What on-chain trading shows

There is no meaningful AAVE/USDT pair on Ethereum DEXes, so the on-chain picture is read through the two real venues: **AAVE/WETH** and **AAVE/USDC**. Aggregated across Ethereum DEX pools:

${dexLines}

Across both quote currencies, Ethereum DEXes saw **${totalBuys} buys vs ${totalSells} sells** over 24 hours (${txnSkew}% buy-side), **$${fmtUsd(totalVol)}** of volume on **$${fmtUsd(totalLiq)}** of combined liquidity.

This is the retail-to-semi-pro flow — the on-chain trader who doesn't need to queue on Binance. A buy skew here post-attack tells you that the decentralized side of the market is stepping in while spot orderbooks are still heavy. A sell skew says the selling hasn't actually exhausted itself and the exchange-only read is masking weaker on-chain conviction.`;

  const section4 = `## Section 4 — Confluence verdict

Pulling all three layers onto one page:

| Layer | Signal | Notes |
|---|---|---|
| Chart | **${chart.verdict.toUpperCase()}** | ${chart.reasons.join("; ")} |
| Smart Money | **${nansen.verdict.toUpperCase()}** | ${nansen.reasons.join("; ")} |
| DEX flow | **${dex.verdict.toUpperCase()}** | ${dex.reasons.join("; ")} |

**Verdict: ${conf.label}** (${conf.strength}; ${conf.bull} bullish / ${conf.bear} bearish / ${conf.neu} neutral across the three reads).

${conf.label === "ALIGNED BULLISH"
  ? "When all three layers line up bullishly after a violent repricing, the market is telling you the first hand is being bought. These are the setups where you don't need to be early — you need to be *in* before price reclaims the EMA50 with confirmation, because the asymmetry reprices fast once the tape flips."
  : conf.label === "ALIGNED BEARISH"
    ? "All three layers pointing the same direction after an attack is the rarer and more dangerous signal. It tells you the post-event bounce hasn't found a real bid, that the smart cohort is not yet defending the name, and that on-chain retail is still distributing. No-catch-the-knife situations usually look exactly like this on the confluence table."
    : conf.label === "LEANING BULLISH"
      ? "Two of three layers point bullishly, one is offside. In post-attack setups the split is the tell: if smart money and DEXes are buying while the chart still looks heavy, you are seeing the transition window where the fundamental bid shows up before the technical does. Sizing here needs to respect the one layer that isn't there yet."
      : conf.label === "LEANING BEARISH"
        ? "Two of three layers lean bearish. That's rarely a 'short aggressively' signal — it's a 'don't buy this dip yet' signal. Wait for a second layer to flip before treating any bounce as a turn."
        : conf.label === "CONFLICTING"
          ? "Conflicting layers are the honest signal to do less. Something is happening underneath the surface that the three reads haven't resolved yet — it could be a rotation of holder base, it could be a stop-run disguised as a turn, it could be a news catalyst not yet priced in. The trade here is usually to wait for two layers to agree before acting."
          : "No layer is offering a clean edge, which is itself useful information — it tells you the market has not made up its mind and that size-weighted patience pays better than conviction here."}`;

  const closing = `## Closing

This is not a recommendation — it's a read of three independent data layers on a name that just absorbed a stress event. The right response to a confluence table like this is to define your invalidation in advance (price level, wallet-flow reversal, DEX sell-skew flipping) and let the tape do the arguing. Post-attack tokens trade on narrative as much as on flow; the moment the story changes, everything in this report becomes stale. Refresh the read before acting on it.`;

  return `# ${headline}

_${oneLine}_

_Generated ${new Date(ctx.now).toUTCString()} · ${ctx.symbol} ${ctx.tf} · Price $${priceNow.toFixed(2)}_

---

${section1}

${section2}

${section3}

${section4}

---

${closing}
`;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
