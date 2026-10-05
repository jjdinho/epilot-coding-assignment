import { isStale } from './price';

export interface Player {
  alias: string;
  score: number;
}

export interface Tick {
  price: string;
  observedAt: string;
}

export interface State {
  price: { value: string; observedAt: string; stale: boolean } | null;
  alias: string;
  score: number;
  openGuess: null;
  lastResult: null;
}

// The response of GET /state, POST /player and POST /guess (§6).
export function buildState(player: Player, tick: Tick | undefined, now: Date): State {
  return {
    price: tick ? { value: tick.price, observedAt: tick.observedAt, stale: isStale(tick.observedAt, now) } : null,
    alias: player.alias,
    score: player.score,
    openGuess: null,
    lastResult: null,
  };
}
