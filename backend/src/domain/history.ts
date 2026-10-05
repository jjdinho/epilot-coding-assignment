// The price chart covers this long (D11).
export const HISTORY_MS = 60_000;

export interface Trade {
  price: string;
  time: string;
}

export interface PricePoint {
  value: string;
  time: string;
}

// One point per second for the last 60 s, oldest first: the last trade in each second, timed at the start of
// that second. Seconds with no trade are skipped. Expects trades newest first, as Coinbase returns them (D11).
export function priceHistory(trades: Trade[], now: Date): PricePoint[] {
  const cutoff = now.getTime() - HISTORY_MS;
  const points = new Map<number, string>();
  for (const { price, time } of trades) {
    const second = Math.floor(Date.parse(time) / 1_000) * 1_000;
    if (second >= cutoff && !points.has(second)) points.set(second, price);
  }
  return [...points].reverse().map(([second, value]) => ({ value, time: new Date(second).toISOString() }));
}
