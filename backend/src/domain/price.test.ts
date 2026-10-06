import { describe, expect, it } from 'vitest';
import { isStale, isValidPrice, shouldFetch } from './price';

describe('isStale', () => {
  const observedAt = '2026-10-02T14:48:33.000Z';

  it('is fresh at exactly 3 s old', () => {
    expect(isStale(observedAt, new Date('2026-10-02T14:48:36.000Z'))).toBe(false);
  });

  it('is stale just over 3 s old', () => {
    expect(isStale(observedAt, new Date('2026-10-02T14:48:36.001Z'))).toBe(true);
  });
});

describe('isValidPrice', () => {
  it.each(['86096.25', '86096', '86096.25000000'])('accepts %s', (value) => {
    expect(isValidPrice(value)).toBe(true);
  });

  it.each([
    ['the empty string', ''],
    ['a word', 'abc'],
    ['a negative', '-1'],
    ['exponent notation', '1e5'],
    ['a number', 86096.25],
    ['a missing value', undefined],
  ])('rejects %s', (_, value) => {
    expect(isValidPrice(value)).toBe(false);
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
