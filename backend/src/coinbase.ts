import type { Trade } from './domain/history';
import { isValidPrice } from './domain/price';

const BASE_URL = 'https://api.exchange.coinbase.com/products/BTC-USD';

// Uncompressed: in Lambda's Node 22, a timeout while reading a gzipped body can leave the read pending for good.
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/${path}`, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(2_000) });
  if (!res.ok) throw new Error(`Coinbase ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

// The latest BTC/USD price (D3). A response without a price is a failed fetch, so it can't score a guess.
export async function fetchTicker(): Promise<string> {
  const { price } = await get<{ price: unknown }>('ticker');
  if (!isValidPrice(price)) throw new Error(`Ticker returned price ${JSON.stringify(price)}`);
  return price;
}

// Recent trades, newest first, for the chart's history (D11).
export function fetchTrades(): Promise<Trade[]> {
  return get<Trade[]>('trades?limit=1000');
}
