import { describe, expect, it } from 'vitest';
import { isStale, isValidObservedAt, priceKey, shouldFetch } from './price';

describe('isStale', () => {
  const observedAt = '2026-10-02T14:48:33.000Z';

  it('is fresh at exactly 3 s old', () => {
    expect(isStale(observedAt, new Date('2026-10-02T14:48:36.000Z'))).toBe(false);
  });

  it('is stale just over 3 s old', () => {
    expect(isStale(observedAt, new Date('2026-10-02T14:48:36.001Z'))).toBe(true);
  });
});

describe('isValidObservedAt', () => {
  it('accepts new Date().toISOString() output', () => {
    expect(isValidObservedAt(new Date().toISOString())).toBe(true);
  });

  it.each([
    ['no milliseconds', '2026-10-02T14:48:33Z'],
    ['an offset instead of Z', '2026-10-02T14:48:33.120+00:00'],
    ['a day that does not exist', '2026-02-30T00:00:00.000Z'],
    ['the old price key', 'PRICE#LATEST'],
    ['the empty string', ''],
    ['a number', 1759416513120],
    ['a missing value', undefined],
  ])('rejects %s', (_, value) => {
    expect(isValidObservedAt(value)).toBe(false);
  });
});

describe('shouldFetch', () => {
  const now = new Date('2026-10-02T14:48:40.000Z');

  it('fetches when the instance has not tried yet', () => {
    expect(shouldFetch(undefined, now)).toBe(true);
  });

  it('waits when the last attempt was 999 ms ago', () => {
    expect(shouldFetch('2026-10-02T14:48:39.001Z', now)).toBe(false);
  });

  it('fetches when the last attempt was exactly 1 s ago', () => {
    expect(shouldFetch('2026-10-02T14:48:39.000Z', now)).toBe(true);
  });
});

describe('priceKey', () => {
  it('is PRICE# plus the timestamp', () => {
    expect(priceKey('2026-10-02T14:48:33.120Z')).toBe('PRICE#2026-10-02T14:48:33.120Z');
  });
});
