import type { LastResult } from './api';

const RESULTS_SHOWN = 5;

// The player's latest results, newest first, one per guess.
export function addResult(results: LastResult[], result: LastResult | null): LastResult[] {
  if (!result || results.some((r) => r.guessedAt === result.guessedAt)) return results;
  return [result, ...results].sort((a, b) => b.guessedAt.localeCompare(a.guessedAt)).slice(0, RESULTS_SHOWN);
}

// The server only keeps the last result, so the browser collects them. Kept next to the player ID, so the history lasts
// as long as the player does (D6), and read fresh each time, so tabs don't overwrite each other's results.
export function storeResult(result: LastResult | null): LastResult[] {
  const stored: LastResult[] = JSON.parse(localStorage.getItem('results') ?? '[]');
  const results = addResult(stored, result);
  if (results !== stored) localStorage.setItem('results', JSON.stringify(results));
  return results;
}
