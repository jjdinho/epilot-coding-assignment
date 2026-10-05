import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, PRICE_KEY, TABLE_NAME } from './db';
import { dueCutoff, scoreGuess, type Direction, type LastResult } from './domain/guess';

const TICKER_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';
// Runs overlap the next minute's run by ~10 s, so a late schedule leaves no gap (D2).
const RUN_MS = 70_000;
const TICK_MS = 1_000;

interface OpenGuess {
  pk: string;
  guessDirection: Direction;
  guessEntryPrice: string;
  guessedAt: string;
}

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
  const now = new Date();
  // Set only the price attributes, leaving anything else on the item alone (§5).
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: PRICE_KEY },
      UpdateExpression: 'SET #price = :price, #exchangeTime = :exchangeTime, #observedAt = :observedAt',
      ExpressionAttributeNames: { '#price': 'price', '#exchangeTime': 'exchangeTime', '#observedAt': 'observedAt' },
      ExpressionAttributeValues: { ':price': price, ':exchangeTime': time, ':observedAt': now.toISOString() },
    }),
  );
  await resolveDueGuesses(price, now);
}

// Resolves every guess at least 60 s old against this tick, unless the price hasn't moved (D4, D5).
async function resolveDueGuesses(price: string, now: Date): Promise<void> {
  const { Items = [] } = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'open-guesses',
      KeyConditionExpression: '#guessStatus = :open AND #guessedAt <= :cutoff',
      ExpressionAttributeNames: { '#guessStatus': 'guessStatus', '#guessedAt': 'guessedAt' },
      ExpressionAttributeValues: { ':open': 'OPEN', ':cutoff': dueCutoff(now) },
    }),
  );
  await Promise.all(Items.map((guess) => resolve(guess as OpenGuess, price, now.toISOString())));
}

async function resolve(guess: OpenGuess, price: string, resolvedAt: string): Promise<void> {
  const delta = scoreGuess(guess.guessDirection, guess.guessEntryPrice, price);
  if (delta === null) return;
  const lastResult: LastResult = {
    direction: guess.guessDirection,
    entryPrice: guess.guessEntryPrice,
    resolvedPrice: price,
    guessedAt: guess.guessedAt,
    resolvedAt,
    delta,
  };
  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: guess.pk },
        UpdateExpression:
          'SET #score = #score + :delta, #lastResult = :lastResult REMOVE #guessDirection, #guessEntryPrice, #guessedAt, #guessStatus',
        // Matching guessedAt stops a lagging index entry from resolving the player's newer guess (§5).
        ConditionExpression: '#guessStatus = :open AND #guessedAt = :guessedAt',
        ExpressionAttributeNames: {
          '#score': 'score',
          '#lastResult': 'lastResult',
          '#guessDirection': 'guessDirection',
          '#guessEntryPrice': 'guessEntryPrice',
          '#guessedAt': 'guessedAt',
          '#guessStatus': 'guessStatus',
        },
        ExpressionAttributeValues: { ':delta': delta, ':lastResult': lastResult, ':open': 'OPEN', ':guessedAt': guess.guessedAt },
        ReturnValues: 'ALL_NEW',
      }),
    );
    // Logs the alias, not the player ID, which is the player's credential (D6).
    console.log('Guess resolved', JSON.stringify({ alias: Attributes?.alias, score: Attributes?.score, ...lastResult }));
  } catch (err) {
    // Overlapping runs both try to resolve the same guess; the other one got there first (D2).
    if (err instanceof ConditionalCheckFailedException) return;
    throw err;
  }
}
