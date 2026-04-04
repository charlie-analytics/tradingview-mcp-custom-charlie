/**
 * Cross-timeframe analysis: RSI-14, EMA-50, EMA-200, and volume across D / 4H / 1H / 15M.
 *
 * All indicators are calculated from raw OHLCV bars — no chart indicators need to be
 * visible. The original symbol and timeframe are restored after the scan.
 */
import { getState, setSymbol, setTimeframe } from './chart.js';
import { getOhlcv } from './data.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const TIMEFRAMES = [
  { key: 'D',   label: 'Daily',  tf: 'D'   },
  { key: '4H',  label: '4 Hour', tf: '240' },
  { key: '1H',  label: '1 Hour', tf: '60'  },
  { key: '15M', label: '15 Min', tf: '15'  },
];

const RSI_PERIOD  = 14;
const EMA_SHORT   = 50;
const EMA_LONG    = 200;
const VOL_MA_BARS = 20;
const BARS_NEEDED = 300;   // 300 bars gives EMA-200 a 100-bar warmup window

// ─── Math helpers ─────────────────────────────────────────────────────────────

function round(n, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/**
 * Wilder-smoothed EMA (standard TV implementation).
 * Returns null if fewer than `period` closes are available.
 */
function calcEma(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with simple average of first `period` bars
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return round(ema);
}

/**
 * Wilder-smoothed RSI (14-period default).
 * Returns null if not enough bars.
 */
function calcRsi(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);

  // Seed avg gain / loss over the first `period` changes
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing for remaining bars
  for (let i = period; i < changes.length; i++) {
    const g = Math.max(0,  changes[i]);
    const l = Math.max(0, -changes[i]);
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs));
}

/**
 * Simple average of the `period` bars *before* the last bar (excludes last so
 * we're not comparing the current bar's volume against itself).
 */
function calcVolAvg(volumes, period = VOL_MA_BARS) {
  const slice = volumes.slice(-(period + 1), -1);
  if (slice.length === 0) return null;
  return Math.round(slice.reduce((s, v) => s + v, 0) / slice.length);
}

// ─── Signal classifiers ───────────────────────────────────────────────────────

function rsiZone(rsi) {
  if (rsi === null)  return 'unknown';
  if (rsi >= 70)     return 'overbought';
  if (rsi <= 30)     return 'oversold';
  return 'neutral';
}

/** Returns 'above' | 'below' | 'unknown' */
function aboveBelow(a, b) {
  if (a === null || b === null) return 'unknown';
  return a > b ? 'above' : 'below';
}

/** Returns 'golden' (EMA50 > EMA200) | 'death' | 'unknown' */
function emaCrossType(ema50, ema200) {
  if (ema50 === null || ema200 === null) return 'unknown';
  return ema50 > ema200 ? 'golden' : 'death';
}

/** Returns 'high' (≥150% avg) | 'normal' | 'low' (≤50% avg) | 'unknown' */
function volumeSignal(volume, avg) {
  if (!avg || avg === 0) return 'unknown';
  const ratio = volume / avg;
  if (ratio >= 1.5) return 'high';
  if (ratio <= 0.5) return 'low';
  return 'normal';
}

/**
 * Full bullish:  price > EMA50 > EMA200
 * Full bearish:  price < EMA50 < EMA200
 * Mixed:         any other configuration (includes one EMA null)
 */
function tfBias(close, ema50, ema200) {
  if (ema50 === null || ema200 === null) return 'mixed';
  if (close > ema50 && close > ema200 && ema50 > ema200) return 'bullish';
  if (close < ema50 && close < ema200 && ema50 < ema200) return 'bearish';
  return 'mixed';
}

// ─── OHLCV read with retry ────────────────────────────────────────────────────

async function fetchBars(count, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await getOhlcv({ count, summary: false });
      if (result.success && result.bars && result.bars.length >= 20) return result.bars;
    } catch {}
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Could not load bar data after 3 attempts — chart may still be syncing');
}

// ─── Summary text ─────────────────────────────────────────────────────────────

function buildSummary(symbol, byTf, alignment) {
  const { bullish_count, bearish_count, mixed_count, verdict, ema_cross_by_tf } = alignment;
  const sentences = [];

  const label = {
    strong_bullish: 'Strong bullish',
    bullish:        'Bullish',
    mixed:          'Mixed',
    bearish:        'Bearish',
    strong_bearish: 'Strong bearish',
  }[verdict] || verdict;

  // Collect TF keys per bias
  const bullishTfs = Object.entries(byTf).filter(([, v]) => v.analysis?.bias === 'bullish').map(([k]) => k);
  const bearishTfs = Object.entries(byTf).filter(([, v]) => v.analysis?.bias === 'bearish').map(([k]) => k);

  sentences.push(
    `${label} on ${symbol}: ${bullish_count} bullish (${bullishTfs.join(', ') || 'none'}), ` +
    `${bearish_count} bearish (${bearishTfs.join(', ') || 'none'}), ${mixed_count} mixed.`
  );

  // EMA cross breakdown
  const goldenTfs = Object.entries(ema_cross_by_tf).filter(([, v]) => v === 'golden').map(([k]) => k);
  const deathTfs  = Object.entries(ema_cross_by_tf).filter(([, v]) => v === 'death').map(([k]) => k);
  if (goldenTfs.length) sentences.push(`EMA50/200 golden cross: ${goldenTfs.join(', ')}.`);
  if (deathTfs.length)  sentences.push(`EMA50/200 death cross: ${deathTfs.join(', ')}.`);

  // RSI extremes
  const overboughtTfs = Object.entries(byTf).filter(([, v]) => v.analysis?.rsi_zone === 'overbought').map(([k]) => k);
  const oversoldTfs   = Object.entries(byTf).filter(([, v]) => v.analysis?.rsi_zone === 'oversold').map(([k]) => k);
  if (overboughtTfs.length) sentences.push(`RSI overbought on ${overboughtTfs.join(', ')}.`);
  if (oversoldTfs.length)   sentences.push(`RSI oversold on ${oversoldTfs.join(', ')}.`);

  // Volume
  const highVolTfs = Object.entries(byTf).filter(([, v]) => v.analysis?.volume_signal === 'high').map(([k]) => k);
  if (highVolTfs.length) sentences.push(`Elevated volume on ${highVolTfs.join(', ')}.`);

  return sentences.join(' ');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyze({ symbol, delay_ms }) {
  if (!symbol) throw new Error('symbol is required');
  const delay = delay_ms ?? 1500;

  // Capture state to restore afterward
  let originalSymbol = null;
  let originalTf = null;
  try {
    const state = await getState();
    originalSymbol = state.symbol   || null;
    originalTf     = state.resolution || null;
  } catch {}

  // Land on the requested symbol before iterating timeframes
  await setSymbol({ symbol });

  const byTf = {};

  for (const { key, label, tf } of TIMEFRAMES) {
    try {
      await setTimeframe({ timeframe: tf });
      // Extra settle time on top of waitForChartReady (new bars may still stream in)
      await new Promise(r => setTimeout(r, delay));

      const bars    = await fetchBars(BARS_NEEDED);
      const closes  = bars.map(b => b.close);
      const volumes = bars.map(b => b.volume);
      const last    = bars[bars.length - 1];

      const rsi    = calcRsi(closes);
      const ema50  = calcEma(closes, EMA_SHORT);
      const ema200 = calcEma(closes, EMA_LONG);
      const volAvg = calcVolAvg(volumes);
      const volRatio = (volAvg && volAvg > 0) ? round(last.volume / volAvg) : null;

      const bias = tfBias(last.close, ema50, ema200);

      byTf[key] = {
        timeframe:    tf,
        label,
        bars_loaded:  bars.length,
        close:        round(last.close),
        volume:       last.volume,
        volume_avg20: volAvg,
        volume_ratio: volRatio,
        rsi_14:       rsi,
        ema_50:       ema50,
        ema_200:      ema200,
        analysis: {
          price_vs_ema50:  aboveBelow(last.close, ema50),
          price_vs_ema200: aboveBelow(last.close, ema200),
          ema50_vs_ema200: aboveBelow(ema50, ema200),
          ema_cross:       emaCrossType(ema50, ema200),
          rsi_zone:        rsiZone(rsi),
          volume_signal:   volumeSignal(last.volume, volAvg),
          bias,
        },
      };
    } catch (err) {
      byTf[key] = { timeframe: tf, label, error: err.message };
    }
  }

  // Restore original symbol and timeframe (best-effort)
  try {
    if (originalSymbol) await setSymbol({ symbol: originalSymbol });
    if (originalTf)     await setTimeframe({ timeframe: originalTf });
  } catch {}

  // ── Alignment ──
  const biases        = Object.values(byTf).map(v => v.analysis?.bias).filter(Boolean);
  const bullish_count = biases.filter(b => b === 'bullish').length;
  const bearish_count = biases.filter(b => b === 'bearish').length;
  const mixed_count   = biases.filter(b => b === 'mixed').length;
  const score         = bullish_count - bearish_count;

  const verdict =
    score >=  3 ? 'strong_bullish' :
    score >=  1 ? 'bullish'        :
    score <= -3 ? 'strong_bearish' :
    score <= -1 ? 'bearish'        : 'mixed';

  const ema_cross_by_tf = {};
  for (const [k, v] of Object.entries(byTf)) {
    if (v.analysis) ema_cross_by_tf[k] = v.analysis.ema_cross;
  }

  const alignment = {
    score,
    bullish_count,
    bearish_count,
    mixed_count,
    verdict,
    fully_aligned: bullish_count === 4 || bearish_count === 4,
    ema_cross_by_tf,
    summary: buildSummary(symbol, byTf, {
      bullish_count, bearish_count, mixed_count, verdict, ema_cross_by_tf,
    }),
  };

  return { success: true, symbol, timeframes: byTf, alignment };
}
