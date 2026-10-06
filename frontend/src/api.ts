import type { Direction, LastResult } from '../../backend/src/domain/guess';
import type { PricePoint } from '../../backend/src/domain/history';
import type { State } from '../../backend/src/domain/state';

export type { Direction, LastResult, PricePoint, State };

// Written into the site bucket at deploy time.
const config: Promise<{ apiUrl: string }> = fetch('/config.json').then((res) => res.json());

// The player's only credential: sent on every request, never rendered (D6).
const playerId = localStorage.getItem('playerId') ?? crypto.randomUUID();
localStorage.setItem('playerId', playerId);

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const { apiUrl } = await config;
  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-player-id': playerId },
  });
}
