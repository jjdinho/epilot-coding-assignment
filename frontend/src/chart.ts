import { HISTORY_MS, type PricePoint } from '../../backend/src/domain/history';

// Adds a polled price if it's newer than the chart's newest point, which drops duplicates and an older price from
// another API instance (D2). Keeps the 60 s up to the new point, anchored on the data, not the device clock (D11).
export function addPoint(points: PricePoint[], point: PricePoint): PricePoint[] {
  const time = Date.parse(point.time);
  const newest = points.at(-1);
  if (newest && time <= Date.parse(newest.time)) return points;
  return [...points.filter((p) => Date.parse(p.time) >= time - HISTORY_MS), point];
}
