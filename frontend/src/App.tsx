import { ArrowDown, ArrowUp, Check, Minus, TrendingDown, TrendingUp, X, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { AliasForm } from './AliasForm';
import { request, type Direction, type LastResult, type PricePoint, type State } from './api';
import { addPoint, change } from './chart';
import { secondsLeft } from './countdown';
import { clock, usd } from './format';
import { PriceChart } from './PriceChart';
import { RESULTS_SHOWN, storeResult } from './results';

const signedUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', signDisplay: 'exceptZero' });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 3, signDisplay: 'exceptZero' });

// The trend badge's icon and colour, by the sign of the price's change.
const TRENDS: Record<number, { Icon: LucideIcon; className: string }> = {
  1: { Icon: TrendingUp, className: 'border-green-600/30 bg-green-50 text-green-700' },
  0: { Icon: Minus, className: '' },
  [-1]: { Icon: TrendingDown, className: 'border-red-600/30 bg-red-50 text-red-700' },
};

const GUESS_ERRORS: Record<string, string> = {
  GUESS_OPEN: 'You already have a guess open.',
  PRICE_STALE: 'The price feed is unavailable. Try again.',
};

export function App() {
  const [state, setState] = useState<State>();
  const [needsAlias, setNeedsAlias] = useState(false);
  const [points, setPoints] = useState<PricePoint[]>([]);
  const [results, setResults] = useState<LastResult[]>([]);
  // Counts accepted guesses, so a poll sent before one can't overwrite the state it returned.
  const guesses = useRef(0);

  useEffect(() => {
    if (needsAlias) return;
    let stopped = false;
    let inFlight = false;
    async function poll() {
      // Skipped while the last poll is in flight, so a slow Coinbase slows polling down instead of stacking requests
      // that spread across API instances, each fetching for itself (D2).
      if (inFlight) return;
      inFlight = true;
      try {
        const sentAfter = guesses.current;
        const res = await request('/state');
        const body = res.ok ? await res.json() : undefined;
        if (stopped || guesses.current !== sentAfter) return;
        if (res.status === 404) setNeedsAlias(true);
        else if (body) {
          setState(body);
          const { price, lastResult } = body as State;
          setResults(storeResult(lastResult));
          if (price) setPoints((points) => addPoint(points, { value: price.value, time: price.observedAt }));
        }
      } finally {
        inFlight = false;
      }
    }
    // The chart's last minute, which also fills the gap left while polling was paused (D11). Kept even if
    // polling has stopped since, because the chart also shows while the alias form is up.
    async function loadHistory() {
      const res = await request('/price/history');
      // On failure the chart keeps what it has, nothing on load, and fills from polls.
      if (res.ok) setPoints((await res.json()).points);
    }
    // A hidden tab doesn't poll, so a forgotten one doesn't make the API fetch prices nobody sees (D10).
    let timer: ReturnType<typeof setInterval> | undefined;
    function pollWhileVisible() {
      clearInterval(timer);
      if (document.visibilityState !== 'visible') return;
      loadHistory();
      poll();
      timer = setInterval(poll, 1_000);
    }
    pollWhileVisible();
    document.addEventListener('visibilitychange', pollWhileVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', pollWhileVisible);
    };
  }, [needsAlias]);

  function onGuessed(next: State) {
    guesses.current++;
    setState(next);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8">
      <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight text-balance">BTC Up/Down</h1>
      {needsAlias ? (
        <>
          <AliasForm onJoined={() => setNeedsAlias(false)} />
          <PriceChart points={points} />
        </>
      ) : state ? (
        <Game state={state} points={points} results={results} onGuessed={onGuessed} />
      ) : (
        <p className="text-muted-foreground">Loading…</p>
      )}
    </main>
  );
}

function Game({
  state,
  points,
  results,
  onGuessed,
}: {
  state: State;
  points: PricePoint[];
  results: LastResult[];
  onGuessed: (state: State) => void;
}) {
  const { alias, score, price, openGuess } = state;
  return (
    <>
      <p className="text-muted-foreground">
        Playing as <strong className="text-foreground">{alias}</strong> · Score{' '}
        <strong className="text-foreground">{score}</strong>
      </p>
      <PriceCard price={price} points={points} />
      <PriceChart points={points} />
      <GuessButtons state={state} onGuessed={onGuessed} />
      <Guesses openGuess={openGuess} results={results} />
    </>
  );
}

function PriceCard({ price, points }: { price: State['price']; points: PricePoint[] }) {
  const trend = change(points);
  return (
    <Card className="@container/card">
      {/* Two columns filled top to bottom: "BTC/USD" over the price, "Last minute" over the trend. One column when the
          card is too narrow for both side by side. */}
      <CardHeader className="grid-flow-col grid-cols-[1fr_auto] grid-rows-[auto_auto] @max-sm/card:grid-flow-row @max-sm/card:grid-cols-1">
        <CardDescription>BTC/USD</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {price ? usd.format(Number(price.value)) : 'Price feed unavailable'}
        </CardTitle>
        {price && trend && <Trend {...trend} />}
      </CardHeader>
      {price?.stale && (
        <CardFooter className="text-sm text-muted-foreground">
          Price feed unavailable · last updated {Math.round((Date.now() - Date.parse(price.observedAt)) / 1_000)} s ago
        </CardFooter>
      )}
    </Card>
  );
}

function Trend({ amount, fraction }: { amount: number; fraction: number }) {
  const { Icon, className } = TRENDS[Math.sign(amount)];
  return (
    <>
      <CardDescription className="justify-self-end @max-sm/card:justify-self-start">Last minute</CardDescription>
      <Badge variant="outline" className={`self-center justify-self-end @max-sm/card:justify-self-start ${className}`}>
        <Icon />
        {signedUsd.format(amount)} ({percent.format(fraction)})
      </Badge>
    </>
  );
}

// Newest first: the open guess, replaced by its result once a poll shows it resolved, then earlier results.
function Guesses({ openGuess, results }: { openGuess: State['openGuess']; results: LastResult[] }) {
  // The open guess counts towards the cards shown, so it pushes the oldest result off.
  const shown = openGuess ? results.slice(0, RESULTS_SHOWN - 1) : results;
  const count = shown.length + (openGuess ? 1 : 0);
  if (!count) return null;
  return (
    <>
      {openGuess && <OpenGuess {...openGuess} />}
      {shown.map((result) => (
        <GuessResult key={result.guessedAt} {...result} />
      ))}
      <p className="text-sm text-muted-foreground">
        Showing last {count} {count === 1 ? 'guess' : 'guesses'}
      </p>
    </>
  );
}

function OpenGuess({ direction, entryPrice, guessedAt }: NonNullable<State['openGuess']>) {
  // Re-rendered by every poll, so the countdown ticks once a second.
  const left = secondsLeft(guessedAt, Date.now());
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          You guessed <strong>{direction.toLowerCase()}</strong> from {usd.format(Number(entryPrice))}
        </CardTitle>
        <CardDescription>
          {left ? `Resolving guess in ${left} ${left === 1 ? 'second' : 'seconds'}` : 'Waiting for the price to move'}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function GuessResult({ direction, entryPrice, resolvedPrice, guessedAt, delta }: LastResult) {
  const rows = [
    ['Your guess', direction === 'UP' ? 'Up' : 'Down'],
    ['Entry price', usd.format(Number(entryPrice))],
    ['Final price', usd.format(Number(resolvedPrice))],
    ['Difference', signedUsd.format(Number(resolvedPrice) - Number(entryPrice))],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Guess at {clock.format(Date.parse(guessedAt))}</CardTitle>
        <CardAction>
          <Badge variant="outline" className={TRENDS[delta].className}>
            {delta > 0 ? <Check /> : <X />}
            {delta > 0 ? '+1' : '-1'}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right">{value}</dd>
            </Fragment>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function GuessButtons({ state: { price, openGuess }, onGuessed }: { state: State; onGuessed: (state: State) => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const disabled = pending || !!openGuess || !price || price.stale;

  async function guess(direction: Direction) {
    setPending(true);
    setMessage('');
    try {
      const res = await request('/guess', { method: 'POST', body: JSON.stringify({ direction }) });
      const body = await res.json();
      if (res.status === 201) return onGuessed(body);
      // The next poll shows the real state, so the message only needs to stay briefly.
      setMessage(GUESS_ERRORS[body.error] ?? 'Something went wrong. Try again.');
      setTimeout(() => setMessage(''), 4_000);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" disabled={disabled} onClick={() => guess('UP')}>
          {openGuess?.direction === 'UP' ? <Check data-icon="inline-start" /> : <ArrowUp data-icon="inline-start" />}
          Up
        </Button>
        <Button size="lg" disabled={disabled} onClick={() => guess('DOWN')}>
          {openGuess?.direction === 'DOWN' ? <Check data-icon="inline-start" /> : <ArrowDown data-icon="inline-start" />}
          Down
        </Button>
      </div>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </>
  );
}
