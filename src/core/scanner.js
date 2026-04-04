/**
 * Core scanner logic — loops symbols, evaluates conditions against indicator or OHLCV data.
 */
import { setSymbol } from './chart.js';
import { getStudyValues, getOhlcv } from './data.js';

const OPERATORS = {
  '<':  (a, b) => a <  b,
  '>':  (a, b) => a >  b,
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a == b,
  '!=': (a, b) => a != b,
};

const OHLCV_FIELDS = new Set(['open', 'high', 'low', 'close', 'volume']);

/**
 * Parse a display value string like "45.23", "1,234.5", "38.2%" into a number.
 */
function parseDisplayValue(raw) {
  const cleaned = String(raw).replace(/[,%]/g, '').trim();
  return parseFloat(cleaned);
}

/**
 * Evaluate a single condition against one symbol's data.
 * Returns { matched, actual_value?, study_name?, reason? }
 */
async function evalCondition({ indicator, field, operator, value }) {
  const op = OPERATORS[operator];

  // OHLCV path — no indicator name, or explicitly price fields
  if (!indicator || OHLCV_FIELDS.has(field.toLowerCase())) {
    const ohlcv = await getOhlcv({ count: 1, summary: false });
    if (!ohlcv.success || !ohlcv.bars || ohlcv.bars.length === 0) {
      return { matched: false, reason: 'Could not load OHLCV data — chart may still be loading' };
    }
    const lastBar = ohlcv.bars[ohlcv.bars.length - 1];
    const actual = lastBar[field.toLowerCase()];
    if (actual === undefined) {
      return { matched: false, reason: `Field "${field}" not found in OHLCV. Use: open, high, low, close, volume` };
    }
    return { matched: op(actual, value), actual_value: actual };
  }

  // Study / indicator path
  const studyData = await getStudyValues();
  if (!studyData.success || studyData.study_count === 0) {
    return { matched: false, reason: 'No indicators visible on chart' };
  }

  const study = studyData.studies.find(s =>
    s.name.toLowerCase().includes(indicator.toLowerCase())
  );
  if (!study) {
    return { matched: false, reason: `Indicator matching "${indicator}" not found on chart (${studyData.study_count} studies loaded)` };
  }

  // Field lookup — try exact match first, then case-insensitive
  let rawVal = study.values[field];
  if (rawVal === undefined) {
    const keyCI = Object.keys(study.values).find(k => k.toLowerCase() === field.toLowerCase());
    rawVal = keyCI !== undefined ? study.values[keyCI] : undefined;
  }
  if (rawVal === undefined) {
    const available = Object.keys(study.values).join(', ');
    return { matched: false, reason: `Field "${field}" not found in "${study.name}". Available: ${available}` };
  }

  const actual = parseDisplayValue(rawVal);
  if (isNaN(actual)) {
    return { matched: false, reason: `Value "${rawVal}" for field "${field}" in "${study.name}" is not numeric` };
  }

  return { matched: op(actual, value), actual_value: actual, study_name: study.name };
}

export async function scan({ symbols, indicator, field, operator, value, delay_ms }) {
  if (!symbols || symbols.length === 0) throw new Error('symbols array is required and cannot be empty');
  if (!field) throw new Error('field is required (e.g., "RSI", "close", "volume")');
  if (!operator) throw new Error('operator is required (<, >, <=, >=, ==, !=)');
  if (value === undefined || value === null) throw new Error('value is required');
  if (!OPERATORS[operator]) throw new Error(`Invalid operator "${operator}". Use: <, >, <=, >=, ==, !=`);

  const delay = delay_ms ?? 2000;
  const matchedSymbols = [];
  const details = [];

  for (const symbol of symbols) {
    let entry;
    try {
      await setSymbol({ symbol });
      // Let the chart settle after symbol change
      await new Promise(r => setTimeout(r, delay));

      const result = await evalCondition({ indicator, field, operator, value });
      entry = { symbol, success: true, ...result };
      if (result.matched) matchedSymbols.push(symbol);
    } catch (err) {
      entry = { symbol, success: false, matched: false, error: err.message };
    }
    details.push(entry);
  }

  return {
    success: true,
    total_scanned: symbols.length,
    matched_count: matchedSymbols.length,
    condition: { indicator: indicator || null, field, operator, value },
    matched_symbols: matchedSymbols,
    details,
  };
}
