const STALE_AFTER_MS = 3_000;
// Each API instance tries Coinbase at most this often (D2).
const PRICE_CACHE_MS = 1_000;

// A price more than 3 s old is stale: the UI disables guessing, and a guess can't name it (D4, D8).
export function isStale(observedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(observedAt) > STALE_AFTER_MS;
}

// Exactly the format the server writes, so a client can only address price items (D4, D6).
export function isValidObservedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  // toISOString() throws on an invalid date.
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

// Counted from the last attempt, not the last success, so a failing Coinbase is still tried at most once a second (D2).
export function shouldFetch(lastAttemptAt: string | undefined, now: Date): boolean {
  return lastAttemptAt === undefined || now.getTime() - Date.parse(lastAttemptAt) >= PRICE_CACHE_MS;
}

// One item per price the API fetches, so a guess can name it (§5).
export function priceKey(observedAt: string): string {
  return `PRICE#${observedAt}`;
}
