import { HISTORY_MS, type PricePoint } from '../../backend/src/domain/history';

// Adds a polled price if it's newer than the chart's newest point, which drops duplicates and an older price from
// another API instance (D2). Keeps the 60 s up to the new point, anchored on the data, not the device clock (D11).
export function addPoint(points: PricePoint[], point: PricePoint): PricePoint[] {
  const time = Date.parse(point.time);
  const newest = points.at(-1);
  if (newest && time <= Date.parse(newest.time)) return points;
  return [...points.filter((p) => Date.parse(p.time) >= time - HISTORY_MS), point];
}

// The price's change across the chart's minute, in dollars and as a fraction of its first price. Undefined while the
// chart is empty.
export function change(points: PricePoint[]): { amount: number; fraction: number } | undefined {
  if (!points.length) return undefined;
  const first = Number(points[0].value);
  const amount = Number(points.at(-1)!.value) - first;
  return { amount, fraction: amount / first };
}

// Each move between neighbouring points, as its start and end across the line's time span (0 to 1) and its sign:
// 1 up, -1 down, 0 unchanged. The chart colours the line by these.
export function moves(points: PricePoint[]): { from: number; to: number; sign: number }[] {
  const start = Date.parse(points[0]?.time);
  const span = Date.parse(points.at(-1)?.time ?? '') - start;
  return points.slice(1).map((p, i) => ({
    from: (Date.parse(points[i].time) - start) / span,
    to: (Date.parse(p.time) - start) / span,
    sign: Math.sign(Number(p.value) - Number(points[i].value)),
  }));
}
