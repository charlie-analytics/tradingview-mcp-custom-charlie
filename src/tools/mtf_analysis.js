import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/mtf_analysis.js';

export function registerMtfAnalysisTools(server) {
  server.tool(
    'chart_mtf_analysis',
    'Cross-timeframe trend analysis for a symbol. Switches across Daily, 4H, 1H, and 15M, calculates RSI-14, EMA-50, EMA-200, and volume from raw bars on each timeframe (no chart indicators required), then returns per-timeframe readings and an overall trend alignment verdict. Original symbol and timeframe are restored after the scan.',
    {
      symbol: z.string().describe(
        'Symbol to analyze (e.g., "AAPL", "ES1!", "BTCUSDT", "NYMEX:CL1!")'
      ),
      delay_ms: z.coerce.number().optional().describe(
        'Extra ms to wait after each timeframe switch before reading bars (default 1500). Increase to 2500+ for slow connections or less-liquid symbols.'
      ),
    },
    async ({ symbol, delay_ms }) => {
      try {
        return jsonResult(await core.analyze({ symbol, delay_ms }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
