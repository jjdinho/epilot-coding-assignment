import { describe, expect, it } from 'vitest';
import { priceHistory } from './history';

describe('priceHistory', () => {
  const now = new Date('2026-10-02T14:48:40.000Z');
  // Coinbase returns trades newest first, with microsecond timestamps.
  const trade = (time: string, price: string) => ({ time, price });

  it('keeps the latest trade in each second, timed at the start of that second', () => {
    const trades = [
      trade('2026-10-02T14:48:39.900001Z', '86012.51000000'),
      trade('2026-10-02T14:48:39.100000Z', '86011.00000000'),
    ];
    expect(priceHistory(trades, now)).toEqual([{ value: '86012.51000000', time: '2026-10-02T14:48:39.000Z' }]);
  });

  it('returns oldest first and skips seconds with no trade', () => {
    const trades = [
      trade('2026-10-02T14:48:39.500000Z', '86012.00000000'),
      trade('2026-10-02T14:48:36.500000Z', '86011.00000000'),
      trade('2026-10-02T14:48:35.500000Z', '86010.00000000'),
    ];
    expect(priceHistory(trades, now)).toEqual([
      { value: '86010.00000000', time: '2026-10-02T14:48:35.000Z' },
      { value: '86011.00000000', time: '2026-10-02T14:48:36.000Z' },
      { value: '86012.00000000', time: '2026-10-02T14:48:39.000Z' },
    ]);
  });

  it('drops trades older than 60 s', () => {
    const trades = [
      trade('2026-10-02T14:47:40.000000Z', '86010.00000000'),
      trade('2026-10-02T14:47:39.999999Z', '86009.00000000'),
      trade('2026-10-02T14:47:20.000000Z', '86008.00000000'),
    ];
    expect(priceHistory(trades, now)).toEqual([{ value: '86010.00000000', time: '2026-10-02T14:47:40.000Z' }]);
  });

  it('is empty with no trades', () => {
    expect(priceHistory([], now)).toEqual([]);
  });
});
