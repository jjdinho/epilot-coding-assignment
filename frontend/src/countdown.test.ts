import { describe, expect, it } from 'vitest';
import { secondsLeft } from './countdown';

describe('secondsLeft', () => {
  const guessedAt = '2026-10-02T14:47:50.000Z';
  const after = (ms: number) => Date.parse(guessedAt) + ms;

  it.each([
    [0, 60],
    [500, 60],
    [18_000, 42],
    [59_001, 1],
    [60_000, 0],
  ])('%i ms after the guess → %i s', (ms, seconds) => {
    expect(secondsLeft(guessedAt, after(ms))).toBe(seconds);
  });

  it('never goes below zero', () => {
    expect(secondsLeft(guessedAt, after(90_000))).toBe(0);
  });
});
