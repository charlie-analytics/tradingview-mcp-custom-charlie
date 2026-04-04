import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/scanner.js';

export function registerScannerTools(server) {
  server.tool(
    'watchlist_scan',
    'Scan an array of symbols by switching to each one, reading indicator or price data, and returning only the symbols that match a condition. Useful for filtering a watchlist by RSI, MACD, price, volume, etc. Indicators must already be visible on the chart.',
    {
      symbols: z.array(z.string()).describe(
        'Symbols to scan (e.g., ["AAPL", "MSFT", "GOOG", "ES1!"])'
      ),
      indicator: z.string().optional().describe(
        'Indicator name substring to read from (e.g., "RSI", "MACD", "Bollinger"). Omit to read from OHLCV price data (open, high, low, close, volume).'
      ),
      field: z.string().describe(
        'Field name to compare. For indicators: the label shown in the data window (e.g., "RSI", "Signal", "Upper", "K%"). For OHLCV: "open", "high", "low", "close", or "volume".'
      ),
      operator: z.enum(['<', '>', '<=', '>=', '==', '!=']).describe(
        'Comparison operator'
      ),
      value: z.coerce.number().describe(
        'Threshold to compare against (e.g., 30 for RSI < 30)'
      ),
      delay_ms: z.coerce.number().optional().describe(
        'Milliseconds to wait after each symbol change before reading data (default 2000)'
      ),
    },
    async ({ symbols, indicator, field, operator, value, delay_ms }) => {
      try {
        return jsonResult(await core.scan({ symbols, indicator, field, operator, value, delay_ms }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
