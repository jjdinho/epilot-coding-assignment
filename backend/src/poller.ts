import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, PRICE_KEY, TABLE_NAME } from './db';

const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
// Runs overlap the next minute's run by ~10 s, so a late schedule leaves no gap (D2).
const RUN_MS = 70_000;
const TICK_MS = 1_000;

export async function handler(): Promise<void> {
  console.log('Polling started');
  const runEnd = Date.now() + RUN_MS;
  while (Date.now() < runEnd) {
    const tickStart = Date.now();
    try {
      await tick();
    } catch (err) {
      console.error('Tick failed', err);
    }
    await new Promise((resolve) => setTimeout(resolve, tickStart + TICK_MS - Date.now()));
  }
  console.log('Polling stopped');
}

async function tick(): Promise<void> {
  const res = await fetch(TICKER_URL, { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) throw new Error(`Ticker returned ${res.status}`);
  const { price, time } = (await res.json()) as { price: string; time: string };
  // Set only the price attributes, leaving anything else on the item alone (§5).
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: PRICE_KEY },
      UpdateExpression: 'SET #price = :price, #exchangeTime = :exchangeTime, #observedAt = :observedAt',
      ExpressionAttributeNames: { '#price': 'price', '#exchangeTime': 'exchangeTime', '#observedAt': 'observedAt' },
      ExpressionAttributeValues: { ':price': price, ':exchangeTime': time, ':observedAt': new Date().toISOString() },
    }),
  );
}
