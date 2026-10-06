const STALE_AFTER_MS = 3_000;
// Each API instance tries Coinbase at most this often (D2).
const PRICE_CACHE_MS = 1_000;

// A price more than 3 s old is stale: the UI disables guessing, and a guess can't open on it (D8).
export function isStale(observedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(observedAt) > STALE_AFTER_MS;
}

// Counted from the last attempt, not the last success, so a failing Coinbase is still tried at most once a second (D2).
export function shouldFetch(lastAttemptAt: string | undefined, now: Date): boolean {
  return lastAttemptAt === undefined || now.getTime() - Date.parse(lastAttemptAt) >= PRICE_CACHE_MS;
}

// A decimal string, as the exchange sends prices. Checked at the boundary, so nothing else can be scored (§3).
const PRICE = /^\d+(\.\d+)?$/;

export function isValidPrice(value: unknown): value is string {
  return typeof value === 'string' && PRICE.test(value);
}
