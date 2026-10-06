import { useId } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { HISTORY_MS, type PricePoint } from '../../backend/src/domain/history';
import { moves } from './chart';
import { clock, usd } from './format';

const config = { value: { label: 'BTC/USD', color: 'var(--chart-2)' } } satisfies ChartConfig;
// The line's colour by the sign of each move.
const MOVE_COLORS: Record<number, string> = {
  1: 'var(--color-green-600)',
  0: 'var(--color-value)',
  [-1]: 'var(--color-red-600)',
};

// The 60 s up to the newest point, scaled to the lowest and highest price in that window (D11).
export function PriceChart({ points }: { points: PricePoint[] }) {
  const data = points.map((p) => ({ time: Date.parse(p.time), value: Number(p.value) }));
  // Ticks on the window's quarter minutes, so they don't shift with every new point.
  const quarter = Math.floor((data.at(-1)?.time ?? 0) / 15_000) * 15_000;
  const lineMoves = moves(points);
  const gradientId = useId();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last minute</CardTitle>
        <CardDescription>BTC/USD</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
          <LineChart accessibilityLayer data={data} margin={{ left: 12, right: 12 }}>
            {/* Hard stops, so each move between two points has one colour. */}
            <defs>
              <linearGradient id={gradientId}>
                {lineMoves.flatMap(({ from, to, sign }, i) => [
                  <stop key={`${i}-from`} offset={from} stopColor={MOVE_COLORS[sign]} />,
                  <stop key={`${i}-to`} offset={to} stopColor={MOVE_COLORS[sign]} />,
                ])}
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              domain={([, newest]) => [newest - HISTORY_MS, newest]}
              ticks={[45_000, 30_000, 15_000, 0].map((ago) => quarter - ago)}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(time) => clock.format(time)}
            />
            <YAxis hide domain={['dataMin', 'dataMax']} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(_, [item]) => clock.format(item.payload.time)}
                  formatter={(value) => usd.format(Number(value))}
                />
              }
            />
            {/* Not animated: a new point arrives every second. */}
            <Line
              dataKey="value"
              type="monotone"
              // The gradient spans the line's bounding box, which has no height if the price never moved, and then
              // the line wouldn't show.
              stroke={lineMoves.some((m) => m.sign) ? `url(#${gradientId})` : 'var(--color-value)'}
              strokeWidth={2}
              dot={false}
              activeDot={{ fill: 'var(--color-value)' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
