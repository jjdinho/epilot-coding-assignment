const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';

// The latest BTC/USD price from Coinbase, with the exchange's own trade time (D3).
export async function fetchTicker(): Promise<{ price: string; exchangeTime: string }> {
  // Uncompressed: in Lambda's Node 22, a timeout while reading a gzipped body can leave the read pending for good.
  const res = await fetch(TICKER_URL, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(2_000) });
  if (!res.ok) throw new Error(`Ticker returned ${res.status}`);
  const { price, time } = (await res.json()) as { price: string; time: string };
  return { price, exchangeTime: time };
}
