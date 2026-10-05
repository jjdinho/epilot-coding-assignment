import { describe, expect, it } from 'vitest';
import { buildState } from './state';

describe('buildState', () => {
  const player = { alias: 'Satoshi', score: 0 };
  const now = new Date('2026-10-02T14:48:40.000Z');

  it('shows the latest tick and whether it is stale', () => {
    const tick = { price: '86024.74', observedAt: '2026-10-02T14:48:33.000Z' };
    expect(buildState(player, tick, now)).toEqual({
      price: { value: '86024.74', observedAt: '2026-10-02T14:48:33.000Z', stale: true },
      alias: 'Satoshi',
      score: 0,
      openGuess: null,
      lastResult: null,
    });
  });

  it('has no price before the first tick', () => {
    expect(buildState(player, undefined, now).price).toBeNull();
  });

  it('has no price when a visit created the price item before the first tick', () => {
    expect(buildState(player, { lastVisitAt: '2026-10-02T14:48:39.000Z' }, now).price).toBeNull();
  });

  it('shows the open guess and the last result', () => {
    const lastResult = {
      direction: 'DOWN' as const,
      entryPrice: '86030.00',
      resolvedPrice: '86020.00',
      guessedAt: '2026-10-02T14:45:00.000Z',
      resolvedAt: '2026-10-02T14:46:01.000Z',
      delta: 1 as const,
    };
    const guessing = {
      ...player,
      guessDirection: 'UP' as const,
      guessEntryPrice: '86010.00',
      guessedAt: '2026-10-02T14:47:50.000Z',
      lastResult,
    };
    expect(buildState(guessing, undefined, now)).toMatchObject({
      openGuess: { direction: 'UP', entryPrice: '86010.00', guessedAt: '2026-10-02T14:47:50.000Z' },
      lastResult,
    });
  });
});
