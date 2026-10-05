import type { Direction, LastResult } from './guess';
import { isStale } from './price';

export interface Player {
  alias: string;
  score: number;
  // Present only while a guess is open (§5).
  guessDirection?: Direction;
  guessEntryPrice?: string;
  guessedAt?: string;
  lastResult?: LastResult;
}

// The PRICE#LATEST item (§5). A visit creates it if it's missing, so it can exist before the first tick (D10).
export interface PriceItem {
  price?: string;
  observedAt?: string;
  lastVisitAt?: string;
  startRequestedAt?: string;
}

export interface State {
  price: { value: string; observedAt: string; stale: boolean } | null;
  alias: string;
  score: number;
  openGuess: { direction: Direction; entryPrice: string; guessedAt: string } | null;
  lastResult: LastResult | null;
}

// The response of GET /state, POST /player and POST /guess (§6).
export function buildState(player: Player, priceItem: PriceItem | undefined, now: Date): State {
  const { guessDirection: direction, guessEntryPrice: entryPrice, guessedAt } = player;
  const { price: value, observedAt } = priceItem ?? {};
  return {
    price: value && observedAt ? { value, observedAt, stale: isStale(observedAt, now) } : null,
    alias: player.alias,
    score: player.score,
    openGuess: direction && entryPrice && guessedAt ? { direction, entryPrice, guessedAt } : null,
    lastResult: player.lastResult ?? null,
  };
}
