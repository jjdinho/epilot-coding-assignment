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

// A price the API fetched and recorded (D2, §5).
export interface PriceItem {
  price: string;
  exchangeTime: string;
  observedAt: string;
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
  return {
    price: priceItem
      ? { value: priceItem.price, observedAt: priceItem.observedAt, stale: isStale(priceItem.observedAt, now) }
      : null,
    alias: player.alias,
    score: player.score,
    openGuess: direction && entryPrice && guessedAt ? { direction, entryPrice, guessedAt } : null,
    lastResult: player.lastResult ?? null,
  };
}
