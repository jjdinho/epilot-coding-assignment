const STALE_AFTER_MS = 5_000;

// A tick more than 5 s old is stale: guessing against it would be unfair (D8).
export function isStale(observedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(observedAt) > STALE_AFTER_MS;
}
