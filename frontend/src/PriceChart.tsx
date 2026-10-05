import { HISTORY_MS, type PricePoint } from '../../backend/src/domain/history';

// viewBox units. The SVG stretches to fill its box, and the line keeps its width.
const WIDTH = 600;
const HEIGHT = 100;

// The 60 s up to the newest point as a plain line, scaled to the lowest and highest price in that window (D11).
export function PriceChart({ points }: { points: PricePoint[] }) {
  const start = Date.parse(points.at(-1)?.time ?? '') - HISTORY_MS;
  const values = points.map((p) => Number(p.value));
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const line = points.map((p, i) => {
    const x = ((Date.parse(p.time) - start) / HISTORY_MS) * WIDTH;
    const y = range ? HEIGHT - ((values[i] - min) / range) * HEIGHT : HEIGHT / 2;
    return `${x},${y}`;
  });
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="BTC/USD over the last minute"
    >
      <polyline points={line.join(' ')} />
    </svg>
  );
}
