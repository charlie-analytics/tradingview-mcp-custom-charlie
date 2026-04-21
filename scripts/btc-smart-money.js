#!/usr/bin/env node

/**
 * btc-smart-money.js
 *
 * Pulls BTC (via WBTC on Ethereum) smart-money + exchange flow from Nansen,
 * reads current BTCUSD chart state from TradingView (via the `tv` CLI),
 * and prints a single confluence inference.
 *
 * Usage:
 *   NANSEN_API_KEY=... node scripts/btc-smart-money.js
 *   (or put NANSEN_API_KEY in .env)
 *
 * Standard plan note: WBTC on Ethereum is the best on-chain proxy for BTC
 * available to a Standard-tier Nansen key. Native Bitcoin chain data is not
 * covered. CEX flows here are WBTC movements to/from exchanges that list it
 * (a subset of real BTC exchange flow, but directionally useful).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const NANSEN_BASE = "https://api.nansen.ai/api/v1";
const WBTC_ETH = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";

function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(REPO_ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      let v = trimmed.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // no .env is fine — may be set in shell
  }
}

async function nansen(path, body) {
  const res = await fetch(`${NANSEN_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apiKey: process.env.NANSEN_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: parsed };
  }
  return { ok: true, data: parsed };
}

function tvCli(...args) {
  try {
    const out = execFileSync("node", [resolve(REPO_ROOT, "src/cli/index.js"), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 19) + "Z";
}

function isoNow() {
  return new Date().toISOString().slice(0, 19) + "Z";
}

function fmtNum(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(digits)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(digits)}K`;
  return n.toFixed(digits);
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${fmtNum(Math.abs(n))}`;
}

function sumNumeric(rows, field) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    const v = Number(row?.[field]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

function rowsFrom(resp) {
  if (!resp?.ok || !resp.data) return [];
  if (Array.isArray(resp.data)) return resp.data;
  if (Array.isArray(resp.data.data)) return resp.data.data;
  if (Array.isArray(resp.data.rows)) return resp.data.rows;
  if (Array.isArray(resp.data.results)) return resp.data.results;
  return [];
}

// Rows come back newest-first. Return [oldest, newest] after sorting by date asc.
function endpoints(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [null, null];
  const sorted = [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return [sorted[0], sorted[sorted.length - 1]];
}

async function main() {
  loadDotEnv();
  if (!process.env.NANSEN_API_KEY) {
    console.error("NANSEN_API_KEY not set. Add it to .env or export it.");
    process.exit(1);
  }

  // 1. Chart state from TradingView
  const state = tvCli("state");
  const quote = tvCli("quote");
  const ohlcv = tvCli("ohlcv", "-n", "50", "-s");

  const symbol = state?.chart_symbol || state?.symbol || "unknown";
  const tf = state?.chart_resolution || state?.resolution || "unknown";
  const price = quote?.last ?? quote?.data?.last ?? null;
  const changePct = ohlcv?.change_pct ?? null;
  const high = ohlcv?.high ?? null;
  const low = ohlcv?.low ?? null;
  const close = ohlcv?.close ?? null;
  const chartBias = deriveChartBias(ohlcv);

  // 2. Nansen — run 4 queries in parallel
  const from = isoDaysAgo(1);
  const from7d = isoDaysAgo(7);
  const to = isoNow();

  const [exchFlow, smFlow, topBuyers, topSellers] = await Promise.all([
    nansen("/tgm/flows", {
      chain: "ethereum",
      token_address: WBTC_ETH,
      date: { from, to },
      label: "exchange",
      pagination: { page: 1, per_page: 200 },
    }),
    nansen("/tgm/flows", {
      chain: "ethereum",
      token_address: WBTC_ETH,
      date: { from, to },
      label: "smart_money",
      pagination: { page: 1, per_page: 200 },
    }),
    nansen("/tgm/who-bought-sold", {
      chain: "ethereum",
      token_address: WBTC_ETH,
      buy_or_sell: "BUY",
      date: { from: from7d, to },
      pagination: { page: 1, per_page: 10 },
      order_by: [{ field: "bought_volume_usd", direction: "DESC" }],
    }),
    nansen("/tgm/who-bought-sold", {
      chain: "ethereum",
      token_address: WBTC_ETH,
      buy_or_sell: "SELL",
      date: { from: from7d, to },
      pagination: { page: 1, per_page: 10 },
      order_by: [{ field: "sold_volume_usd", direction: "DESC" }],
    }),
  ]);

  // Exchange flow (24h) — Nansen returns outflow fields as signed-negative, so
  // net = straight sum of all 4 fields across rows. Positive = net inflow to
  // exchanges (bearish, supply being added to orderbooks).
  const exchRows = rowsFrom(exchFlow);
  const cexIn = sumNumeric(exchRows, "total_inflows_cex");
  const cexOut = sumNumeric(exchRows, "total_outflows_cex");
  const dexIn = sumNumeric(exchRows, "total_inflows_dex");
  const dexOut = sumNumeric(exchRows, "total_outflows_dex");
  const exchNetFlows = cexIn + cexOut + dexIn + dexOut;
  // token_amount is the total WBTC held by this cohort at each snapshot. Delta
  // between oldest and newest is the cleanest signal — robust to null flow fields.
  const [exchOld, exchNew] = endpoints(exchRows);
  const exchHoldingsDelta = exchNew && exchOld ? Number(exchNew.token_amount) - Number(exchOld.token_amount) : null;
  const exchNet = exchHoldingsDelta ?? exchNetFlows;

  // Smart money (24h) — flow fields are often null on Standard tier, so we lean
  // on token_amount delta over the window.
  const smRows = rowsFrom(smFlow);
  const [smOld, smNew] = endpoints(smRows);
  const smHoldingsDelta = smNew && smOld ? Number(smNew.token_amount) - Number(smOld.token_amount) : null;
  const smHoldersOld = smOld ? Number(smOld.holders_count) : null;
  const smHoldersNew = smNew ? Number(smNew.holders_count) : null;
  const smNet = smHoldingsDelta ?? 0;

  const onChainBias = deriveOnChainBias(smNet, exchNet);

  // Print report
  printReport({
    symbol,
    tf,
    price,
    changePct,
    high,
    low,
    close,
    chartBias,
    exchFlow,
    smFlow,
    topBuyers,
    topSellers,
    cexIn,
    cexOut,
    dexIn,
    dexOut,
    exchNetFlows,
    exchHoldingsDelta,
    exchHoldingsOld: exchOld?.token_amount,
    exchHoldingsNew: exchNew?.token_amount,
    exchNet,
    smHoldingsOld: smOld?.token_amount,
    smHoldingsNew: smNew?.token_amount,
    smHoldingsDelta,
    smHoldersOld,
    smHoldersNew,
    smNet,
    onChainBias,
  });
}

function deriveChartBias(ohlcv) {
  if (!ohlcv?.success) return "unknown";
  const changeStr = ohlcv.change_pct ?? "0";
  const pct = parseFloat(String(changeStr).replace("%", ""));
  if (Number.isNaN(pct)) return "unknown";
  if (pct > 2) return "bullish";
  if (pct < -2) return "bearish";
  return "neutral";
}

function deriveOnChainBias(smNet, exchNet) {
  // SM accumulating (+) and exchanges bleeding supply (exchNet < 0) = bullish
  // SM distributing (-) and exchanges taking in supply (exchNet > 0) = bearish
  let score = 0;
  if (smNet > 0) score += 1;
  if (smNet < 0) score -= 1;
  if (exchNet < 0) score += 1;
  if (exchNet > 0) score -= 1;
  if (score >= 1) return "bullish";
  if (score <= -1) return "bearish";
  return "neutral";
}

function confluence(chart, onchain) {
  if (chart === "unknown" || onchain === "unknown") return "insufficient data";
  if (chart === onchain && chart !== "neutral") return `ALIGNED ${chart.toUpperCase()}`;
  if ((chart === "bullish" && onchain === "bearish") || (chart === "bearish" && onchain === "bullish")) {
    return `DIVERGENT (chart ${chart} vs on-chain ${onchain})`;
  }
  return `MIXED (chart ${chart}, on-chain ${onchain})`;
}

function printTopList(title, resp, volField, tokenField) {
  console.log(`  ${title}:`);
  if (!resp?.ok) {
    const code = resp?.status ?? "?";
    console.log(`    (unavailable — HTTP ${code}${code === 401 || code === 403 ? ", likely not in Standard plan" : ""})`);
    return;
  }
  const rows = rowsFrom(resp).slice(0, 5);
  if (rows.length === 0) {
    console.log("    (no data returned)");
    return;
  }
  for (const [i, r] of rows.entries()) {
    const addr = (r.address || "").slice(0, 10);
    const label = r.address_label || r.label || "unlabeled";
    const vol = fmtUsd(Number(r[volField]));
    const tok = Number(r[tokenField]);
    const tokStr = Number.isFinite(tok) ? `${fmtNum(tok, 2)} WBTC` : "";
    console.log(`    ${i + 1}. ${addr}… [${label}] — ${vol} ${tokStr}`);
  }
}

function printReport(r) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log("  BTC Smart Money + Chart Confluence");
  console.log(`${line}\n`);

  console.log("CHART (TradingView)");
  console.log(`  Symbol: ${r.symbol}   Timeframe: ${r.tf}   Price: ${r.price ?? "n/a"}`);
  if (r.high != null && r.low != null) {
    console.log(`  Last 50 bars: H ${r.high}  L ${r.low}  C ${r.close}  Δ ${r.changePct ?? "n/a"}`);
  }
  console.log(`  Bias: ${r.chartBias.toUpperCase()}\n`);

  console.log("ON-CHAIN (Nansen, WBTC on Ethereum)");
  if (r.smFlow?.ok && r.smHoldingsDelta != null) {
    const sign = r.smHoldingsDelta >= 0 ? "+" : "";
    const dir = r.smHoldingsDelta > 0 ? "ACCUMULATING" : r.smHoldingsDelta < 0 ? "DISTRIBUTING" : "flat";
    console.log(
      `  Smart Money 24h: ${fmtNum(r.smHoldingsOld)} → ${fmtNum(r.smHoldingsNew)} WBTC  (Δ ${sign}${fmtNum(r.smHoldingsDelta, 3)}, ${dir})`,
    );
    if (r.smHoldersOld != null && r.smHoldersNew != null) {
      console.log(`                   holders: ${r.smHoldersOld} → ${r.smHoldersNew}`);
    }
  } else {
    console.log(`  Smart Money flow: unavailable (HTTP ${r.smFlow?.status ?? "?"})`);
  }
  if (r.exchFlow?.ok && r.exchHoldingsDelta != null) {
    const sign = r.exchHoldingsDelta >= 0 ? "+" : "";
    const dir = r.exchHoldingsDelta < 0 ? "BLEEDING (bullish)" : r.exchHoldingsDelta > 0 ? "LOADING (bearish)" : "flat";
    console.log(
      `  Exchange 24h:    ${fmtNum(r.exchHoldingsOld)} → ${fmtNum(r.exchHoldingsNew)} WBTC  (Δ ${sign}${fmtNum(r.exchHoldingsDelta, 2)}, ${dir})`,
    );
    console.log(
      `                   hourly flows — CEX in ${fmtNum(r.cexIn)} / out ${fmtNum(Math.abs(r.cexOut))} | DEX in ${fmtNum(r.dexIn)} / out ${fmtNum(Math.abs(r.dexOut))}`,
    );
  } else {
    console.log(`  Exchange flow: unavailable (HTTP ${r.exchFlow?.status ?? "?"})`);
  }
  console.log(`  On-chain bias: ${r.onChainBias.toUpperCase()}\n`);

  console.log("TOP ACTIVITY (7d)");
  printTopList("Top buyers", r.topBuyers, "bought_volume_usd", "bought_token_volume");
  printTopList("Top sellers", r.topSellers, "sold_volume_usd", "sold_token_volume");
  console.log();

  console.log("CONFLUENCE");
  console.log(`  ${confluence(r.chartBias, r.onChainBias)}\n`);

  console.log("CAVEATS");
  console.log("  • On-chain flows are WBTC-on-Ethereum; native BTC is not covered.");
  console.log("  • CEX flow here only includes exchanges that custody WBTC.");
  console.log("  • Chart bias here is a naive Δ-over-last-50-bars proxy — layer your own indicators for real signal.\n");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
