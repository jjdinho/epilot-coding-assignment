import { RESOLVE_AFTER_MS } from '../../backend/src/domain/guess';

// Whole seconds until the guess can resolve. Taken from the server's guessedAt, so it survives reloads (§3).
export function secondsLeft(guessedAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(guessedAt) + RESOLVE_AFTER_MS - now) / 1_000));
}
