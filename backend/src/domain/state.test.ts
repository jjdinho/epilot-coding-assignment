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
});
