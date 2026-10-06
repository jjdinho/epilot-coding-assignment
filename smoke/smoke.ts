// Smoke test against the deployed API: API_URL=<ApiUrl output> npm run smoke
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const apiUrl = process.env.API_URL;
if (!apiUrl) throw new Error('Set API_URL to the stack output ApiUrl');

async function call(method: string, path: string, playerId: string, body?: unknown) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-player-id': playerId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    // Names the failing check, which the assertion's stack trace doesn't.
    console.log(`✗ ${name}`);
    throw err;
  }
  console.log(`✓ ${name}`);
}

const playerId = randomUUID();
// Smoke aliases stay reserved for good, which is accepted (D9).
const alias = `smoke_${randomBytes(4).toString('hex')}`;

interface Price {
  value: string;
  observedAt: string;
  stale: boolean;
}

// The price on the player's screen, which a guess names by its observedAt (D4).
async function priceOnScreen(): Promise<Price> {
  return (await call('GET', '/state', playerId)).body.price;
}

await check('Bad player ID → 400 INVALID_PLAYER_ID', async () => {
  // A price item's key, which the check keeps clients from addressing (D6).
  assert.deepEqual(await call('GET', '/state', 'PRICE#2026-10-02T14:48:33.120Z'), {
    status: 400,
    body: { error: 'INVALID_PLAYER_ID' },
  });
});

await check('New player ID → GET /state 404', async () => {
  assert.deepEqual(await call('GET', '/state', playerId), { status: 404, body: { error: 'PLAYER_NOT_FOUND' } });
});

await check('GET /price/history, with no player → points from the last minute, oldest first', async () => {
  const { status, body } = await call('GET', '/price/history', randomUUID());
  assert.equal(status, 200);
  const times: number[] = body.points.map((p: { time: string }) => Date.parse(p.time));
  assert.ok(times.length > 0, 'No points');
  assert.ok(times.every((time, i) => i === 0 || time > times[i - 1]), 'Not oldest first, one per second');
  // Roughly, allowing a few seconds between this machine's clock and AWS's.
  assert.ok(times[0] >= Date.now() - 65_000 && times.at(-1)! <= Date.now() + 5_000, 'Not within the last minute');
});

await check('POST /player → 201, score 0', async () => {
  const { status, body } = await call('POST', '/player', playerId, { alias });
  assert.equal(status, 201);
  assert.equal(body.alias, alias);
  assert.equal(body.score, 0);
});

await check('Same alias, other case, from another new ID → 409 ALIAS_TAKEN', async () => {
  assert.deepEqual(await call('POST', '/player', randomUUID(), { alias: alias.toUpperCase() }), {
    status: 409,
    body: { error: 'ALIAS_TAKEN' },
  });
});

await check('Same ID again → 409 PLAYER_EXISTS', async () => {
  assert.deepEqual(await call('POST', '/player', playerId, { alias }), { status: 409, body: { error: 'PLAYER_EXISTS' } });
});

let firstPrice: Price;
await check('GET /state → the alias, score 0, a fresh price on the first call', async () => {
  const { status, body } = await call('GET', '/state', playerId);
  assert.equal(status, 200);
  assert.equal(body.alias, alias);
  assert.equal(body.score, 0);
  assert.equal(body.price?.stale, false);
  firstPrice = body.price;
});

await check('Guess from an unknown player ID → 404 PLAYER_NOT_FOUND', async () => {
  // An unknown player can't get a price of its own, so it names the real player's, while it's still fresh.
  assert.deepEqual(await call('POST', '/guess', randomUUID(), { direction: 'UP', priceObservedAt: firstPrice.observedAt }), {
    status: 404,
    body: { error: 'PLAYER_NOT_FOUND' },
  });
});

await check('Bad direction → 400 INVALID_DIRECTION', async () => {
  assert.deepEqual(await call('POST', '/guess', playerId, { direction: 'SIDEWAYS' }), {
    status: 400,
    body: { error: 'INVALID_DIRECTION' },
  });
});

await check('Missing priceObservedAt, or one without milliseconds → 400 INVALID_PRICE_OBSERVED_AT', async () => {
  for (const priceObservedAt of [undefined, '2026-10-02T14:48:33Z']) {
    assert.deepEqual(await call('POST', '/guess', playerId, { direction: 'UP', priceObservedAt }), {
      status: 400,
      body: { error: 'INVALID_PRICE_OBSERVED_AT' },
    });
  }
});

await check('A priceObservedAt the server never recorded → 409 PRICE_EXPIRED', async () => {
  assert.deepEqual(await call('POST', '/guess', playerId, { direction: 'UP', priceObservedAt: new Date().toISOString() }), {
    status: 409,
    body: { error: 'PRICE_EXPIRED' },
  });
});

await check('A recorded price more than 3 s old → 409 PRICE_EXPIRED', async () => {
  const { observedAt } = await priceOnScreen();
  await sleep(3_500);
  assert.deepEqual(await call('POST', '/guess', playerId, { direction: 'UP', priceObservedAt: observedAt }), {
    status: 409,
    body: { error: 'PRICE_EXPIRED' },
  });
});

let guessSentAt = 0;
await check('Guess naming the price on screen → 201, with exactly that price as the entry price', async () => {
  const price = await priceOnScreen();
  guessSentAt = Date.now();
  const { status, body } = await call('POST', '/guess', playerId, { direction: 'UP', priceObservedAt: price.observedAt });
  assert.equal(status, 201);
  assert.equal(body.openGuess?.direction, 'UP');
  // Compared as strings: the entry price is the very price the player saw (D4).
  assert.equal(body.openGuess?.entryPrice, price.value);
});

await check('Second guess → 409 GUESS_OPEN', async () => {
  const { observedAt } = await priceOnScreen();
  assert.deepEqual(await call('POST', '/guess', playerId, { direction: 'DOWN', priceObservedAt: observedAt }), {
    status: 409,
    body: { error: 'GUESS_OPEN' },
  });
});

console.log('  Waiting for the resolver to resolve the guess, which takes over a minute…');
await check('The resolver resolves the guess within 100 s, and the score moves by lastResult.delta', async () => {
  // GET /state's backup can't act before 2 minutes (D5), so only the resolver can resolve the guess in time.
  const giveUpAt = guessSentAt + 100_000;
  let state;
  do {
    await sleep(2_000);
    state = (await call('GET', '/state', playerId)).body;
  } while (state.openGuess && Date.now() < giveUpAt);
  assert.equal(state.openGuess, null, 'Still open 100 s after the guess');

  const { delta, guessedAt, resolvedAt, entryPrice, resolvedPrice } = state.lastResult;
  assert.ok(delta === 1 || delta === -1);
  // The player started at 0.
  assert.equal(state.score, delta);
  // Resolved by a price fetched at least 60 s after the guess, at a different price (D4, D5).
  assert.ok(Date.parse(resolvedAt) - Date.parse(guessedAt) >= 60_000);
  assert.notEqual(Number(resolvedPrice), Number(entryPrice));
});
