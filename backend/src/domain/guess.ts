export type Direction = 'UP' | 'DOWN';

export interface LastResult {
  direction: Direction;
  entryPrice: string;
  resolvedPrice: string;
  guessedAt: string;
  resolvedAt: string;
  delta: 1 | -1;
}

// A guess can resolve once this long has passed since it was made.
export const RESOLVE_AFTER_MS = 60_000;

export function isValidDirection(direction: unknown): direction is Direction {
  return direction === 'UP' || direction === 'DOWN';
}

// +1 if the price moved the guessed way, −1 if not, null if it hasn't moved (§3).
// Prices are compared as numbers: the exchange may send "86010" or "86010.00".
export function scoreGuess(direction: Direction, entryPrice: string, price: string): 1 | -1 | null {
  const change = Number(price) - Number(entryPrice);
  if (change === 0) return null;
  return change > 0 === (direction === 'UP') ? 1 : -1;
}

// Guesses made at or before this time are due (D4).
export function dueCutoff(now: Date): string {
  return new Date(now.getTime() - RESOLVE_AFTER_MS).toISOString();
}
