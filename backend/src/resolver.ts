import type { SQSEvent } from 'aws-lambda';
import { scoreGuess } from './domain/guess';
import { resolveGuess, sendResolveMessage, type ResolveMessage } from './guesses';
import { fetchTicker } from './ticker';

// Check again soon when the price hasn't moved, so the guess resolves soon after it does (D5).
const RECHECK_DELAY_S = 2;
// Longer when Coinbase is down, so an outage doesn't make every open guess call it every 2 s (D5).
const RETRY_DELAY_S = 10;

// One message per guess, delayed 60 s (D5). Returns only once the guess is resolved, gone, or its message re-sent.
// Any other error throws, and SQS delivers the message again after its visibility timeout.
export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) await resolve(JSON.parse(record.body));
}

async function resolve(message: ResolveMessage): Promise<void> {
  let price: string;
  try {
    ({ price } = await fetchTicker());
  } catch (err) {
    console.error('Ticker failed', err);
    return sendResolveMessage(message, RETRY_DELAY_S);
  }
  const resolvedAt = new Date().toISOString();
  const delta = scoreGuess(message.direction, message.entryPrice, price);
  if (delta === null) return sendResolveMessage(message, RECHECK_DELAY_S);
  // Undefined means the guess was already resolved or never saved. Either way, this message is done.
  await resolveGuess(message, delta, price, resolvedAt);
}
