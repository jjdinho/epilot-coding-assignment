import { describe, expect, it } from 'vitest';
import { addResult } from './results';

describe('addResult', () => {
  const result = (minute: number) => ({
    direction: 'UP' as const,
    entryPrice: '86000.00',
    resolvedPrice: '86010.00',
    guessedAt: `2026-10-06T14:${String(minute).padStart(2, '0')}:00.000Z`,
    resolvedAt: `2026-10-06T14:${String(minute + 1).padStart(2, '0')}:00.000Z`,
    delta: 1 as const,
  });

  it('adds a new result at the top', () => {
    expect(addResult([result(1)], result(2))).toEqual([result(2), result(1)]);
  });

  it('ignores no result', () => {
    const results = [result(1)];
    expect(addResult(results, null)).toBe(results);
  });

  it('ignores a result it already has', () => {
    const results = [result(2), result(1)];
    expect(addResult(results, result(1))).toBe(results);
  });

  it('keeps the newest five', () => {
    const results = [result(5), result(4), result(3), result(2), result(1)];
    expect(addResult(results, result(6))).toEqual([result(6), result(5), result(4), result(3), result(2)]);
  });

  it('keeps newest first when an older result arrives late', () => {
    expect(addResult([result(3)], result(2))).toEqual([result(3), result(2)]);
  });
});
