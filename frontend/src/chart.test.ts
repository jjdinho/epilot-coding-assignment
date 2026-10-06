import { describe, expect, it } from 'vitest';
import { addPoint, change, moves } from './chart';

describe('addPoint', () => {
  const point = (time: string, value = '86010.00') => ({ value, time });
  const points = [point('2026-10-02T14:47:40.000Z'), point('2026-10-02T14:48:39.000Z')];

  it('starts an empty chart', () => {
    expect(addPoint([], point('2026-10-02T14:48:40.000Z'))).toEqual([point('2026-10-02T14:48:40.000Z')]);
  });

  it('ignores a point that is not newer than the newest', () => {
    expect(addPoint(points, point('2026-10-02T14:48:39.000Z', '86020.00'))).toBe(points);
    expect(addPoint(points, point('2026-10-02T14:48:38.500Z'))).toBe(points);
  });

  it('appends a newer point and keeps points up to 60 s before it', () => {
    expect(addPoint(points, point('2026-10-02T14:48:40.000Z'))).toEqual([...points, point('2026-10-02T14:48:40.000Z')]);
  });

  it('drops points more than 60 s before the new point', () => {
    expect(addPoint(points, point('2026-10-02T14:48:40.001Z'))).toEqual([
      point('2026-10-02T14:48:39.000Z'),
      point('2026-10-02T14:48:40.001Z'),
    ]);
  });
});

describe('change', () => {
  const point = (value: string) => ({ value, time: '2026-10-02T14:48:40.000Z' });

  it('is undefined for an empty chart', () => {
    expect(change([])).toBeUndefined();
  });

  it('is the change from the first to the newest point, in dollars and as a fraction of the first', () => {
    const up = change([point('80000.00'), point('80010.00'), point('80040.00')]);
    expect(up?.amount).toBeCloseTo(40);
    expect(up?.fraction).toBeCloseTo(0.0005);
    const down = change([point('80000.00'), point('79960.00')]);
    expect(down?.amount).toBeCloseTo(-40);
    expect(down?.fraction).toBeCloseTo(-0.0005);
  });

  it('is zero for a single point', () => {
    expect(change([point('80000.00')])).toEqual({ amount: 0, fraction: 0 });
  });
});

describe('moves', () => {
  const point = (time: string, value: string) => ({ value, time: `2026-10-02T14:48:${time}.000Z` });

  it('is empty for fewer than two points', () => {
    expect(moves([])).toEqual([]);
    expect(moves([point('00', '80000.00')])).toEqual([]);
  });

  it('spans each move between neighbours across the line, with its sign', () => {
    expect(
      moves([point('00', '80000.00'), point('10', '80010.00'), point('15', '80010.00'), point('20', '80005.00')]),
    ).toEqual([
      { from: 0, to: 0.5, sign: 1 },
      { from: 0.5, to: 0.75, sign: 0 },
      { from: 0.75, to: 1, sign: -1 },
    ]);
  });
});
