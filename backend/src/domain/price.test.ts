import { describe, expect, it } from 'vitest';
import { isStale } from './price';

describe('isStale', () => {
  const observedAt = '2026-10-02T14:48:33.000Z';

  it('is fresh at exactly 5 s old', () => {
    expect(isStale(observedAt, new Date('2026-10-02T14:48:38.000Z'))).toBe(false);
  });

  it('is stale just over 5 s old', () => {
    expect(isStale(observedAt, new Date('2026-10-02T14:48:38.001Z'))).toBe(true);
  });
});
