import { useEffect, useRef, useState } from 'react';
import { AliasForm } from './AliasForm';
import { request, type Direction, type PricePoint, type State } from './api';
import { addPoint } from './chart';
import { secondsLeft } from './countdown';
import { PriceChart } from './PriceChart';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const GUESS_ERRORS: Record<string, string> = {
  GUESS_OPEN: 'You already have a guess open.',
  PRICE_STALE: 'The price feed is unavailable. Try again in a moment.',
};

export function App() {
  const [state, setState] = useState<State>();
  const [needsAlias, setNeedsAlias] = useState(false);
  const [points, setPoints] = useState<PricePoint[]>([]);
  // Counts accepted guesses, so a poll sent before one can't overwrite the state it returned.
  const guesses = useRef(0);

  useEffect(() => {
    if (needsAlias) return;
    let stopped = false;
    async function poll() {
      const sentAfter = guesses.current;
      const res = await request('/state');
      const body = res.ok ? await res.json() : undefined;
      if (stopped || guesses.current !== sentAfter) return;
      if (res.status === 404) setNeedsAlias(true);
      else if (body) {
        setState(body);
        const { price } = body as State;
        if (price) setPoints((points) => addPoint(points, { value: price.value, time: price.observedAt }));
      }
    }
    // The chart's last minute, which also fills the gap left while polling was paused (D11). Kept even if
    // polling has stopped since, because the chart also shows while the alias form is up.
    async function loadHistory() {
      const res = await request('/price/history');
      // On failure the chart keeps what it has, nothing on load, and fills from polls.
      if (res.ok) setPoints((await res.json()).points);
    }
    // A hidden tab doesn't poll, so a forgotten one doesn't keep the poller running (D10).
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
    <main>
      <h1>BTC Up/Down</h1>
      {needsAlias ? (
        <>
          <AliasForm onJoined={() => setNeedsAlias(false)} />
          <PriceChart points={points} />
        </>
      ) : state ? (
        <Game state={state} points={points} onGuessed={onGuessed} />
      ) : (
        <p>Loading…</p>
      )}
    </main>
  );
}

function Game({ state, points, onGuessed }: { state: State; points: PricePoint[]; onGuessed: (state: State) => void }) {
  const { alias, score, price, openGuess, lastResult } = state;
  // Re-rendered by every poll, so the countdown ticks once a second.
  const left = openGuess && secondsLeft(openGuess.guessedAt, Date.now());
  return (
    <>
      <p>
        Playing as <strong>{alias}</strong> · Score <strong>{score}</strong>
      </p>
      <p>BTC/USD</p>
      <p className="price">{price ? usd.format(Number(price.value)) : 'waiting for the first price'}</p>
      {price?.stale && (
        <p>
          Price feed unavailable · last updated {Math.round((Date.now() - Date.parse(price.observedAt)) / 1_000)} s ago
        </p>
      )}
      <PriceChart points={points} />
      <GuessButtons state={state} onGuessed={onGuessed} />
      {openGuess && (
        <p>
          You guessed <strong>{openGuess.direction.toLowerCase()}</strong> from {usd.format(Number(openGuess.entryPrice))}.{' '}
          {left ? `${left} s to go.` : 'Waiting for the price to move.'}
        </p>
      )}
      {lastResult && (
        <p>
          Last guess: {lastResult.direction.toLowerCase()}, {usd.format(Number(lastResult.entryPrice))} →{' '}
          {usd.format(Number(lastResult.resolvedPrice))}, <strong>{lastResult.delta > 0 ? '+1' : '-1'}</strong>
        </p>
      )}
    </>
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
      <p className="guess">
        <button disabled={disabled} onClick={() => guess('UP')}>
          Up
        </button>
        <button disabled={disabled} onClick={() => guess('DOWN')}>
          Down
        </button>
      </p>
      {message && <p role="alert">{message}</p>}
    </>
  );
}
