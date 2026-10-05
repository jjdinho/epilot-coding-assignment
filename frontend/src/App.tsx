import { useEffect, useState } from 'react';
import { AliasForm } from './AliasForm';
import { request, type State } from './api';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function App() {
  const [state, setState] = useState<State>();
  const [needsAlias, setNeedsAlias] = useState(false);

  useEffect(() => {
    if (needsAlias) return;
    let stopped = false;
    async function poll() {
      const res = await request('/state');
      if (stopped) return;
      if (res.status === 404) setNeedsAlias(true);
      else if (res.ok) setState(await res.json());
    }
    poll();
    const timer = setInterval(poll, 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [needsAlias]);

  return (
    <main>
      <h1>BTC Up/Down</h1>
      {needsAlias ? (
        <AliasForm onJoined={() => setNeedsAlias(false)} />
      ) : state ? (
        <Game state={state} />
      ) : (
        <p>Loading…</p>
      )}
    </main>
  );
}

function Game({ state: { alias, score, price } }: { state: State }) {
  return (
    <>
      <p>
        Playing as <strong>{alias}</strong> · Score <strong>{score}</strong>
      </p>
      <p>BTC/USD</p>
      <p className="price">{price ? usd.format(Number(price.value)) : 'waiting for the first price'}</p>
      {price?.stale && <p>Last updated {Math.round((Date.now() - Date.parse(price.observedAt)) / 1_000)} s ago</p>}
    </>
  );
}
