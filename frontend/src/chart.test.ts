import { describe, expect, it } from 'vitest';
import { addPoint } from './chart';

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
