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
  await run();
  console.log(`✓ ${name}`);
}

const playerId = randomUUID();
// Smoke aliases stay reserved for good, which is accepted (D9).
const alias = `smoke_${randomBytes(4).toString('hex')}`;

await check('Bad player ID → 400 INVALID_PLAYER_ID', async () => {
  assert.deepEqual(await call('GET', '/state', 'PRICE#LATEST'), { status: 400, body: { error: 'INVALID_PLAYER_ID' } });
});

await check('New player ID → GET /state 404', async () => {
  assert.deepEqual(await call('GET', '/state', playerId), { status: 404, body: { error: 'PLAYER_NOT_FOUND' } });
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

await check('GET /state → the alias, score 0, a fresh price', async () => {
  const { status, body } = await call('GET', '/state', playerId);
  assert.equal(status, 200);
  assert.equal(body.alias, alias);
  assert.equal(body.score, 0);
  assert.equal(body.price?.stale, false);
});

await check('Guess from an unknown player ID → 404 PLAYER_NOT_FOUND', async () => {
  assert.deepEqual(await call('POST', '/guess', randomUUID(), { direction: 'UP' }), {
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

await check('Guess → 201 with an open guess', async () => {
  const { status, body } = await call('POST', '/guess', playerId, { direction: 'UP' });
  assert.equal(status, 201);
  assert.equal(body.openGuess?.direction, 'UP');
});

await check('Second guess → 409 GUESS_OPEN', async () => {
  assert.deepEqual(await call('POST', '/guess', playerId, { direction: 'DOWN' }), {
    status: 409,
    body: { error: 'GUESS_OPEN' },
  });
});

console.log('  Waiting for the poller to resolve the guess, which takes over a minute…');
await check('The guess resolves, and the score moves by lastResult.delta', async () => {
  const giveUpAt = Date.now() + 3 * 60_000;
  let state;
  do {
    await sleep(2_000);
    state = (await call('GET', '/state', playerId)).body;
  } while (state.openGuess && Date.now() < giveUpAt);
  assert.equal(state.openGuess, null, 'Still open after 3 minutes');

  const { delta, guessedAt, resolvedAt, entryPrice, resolvedPrice } = state.lastResult;
  assert.ok(delta === 1 || delta === -1);
  // The player started at 0.
  assert.equal(state.score, delta);
  // Resolved at a tick at least 60 s after the guess, at a different price (D4).
  assert.ok(Date.parse(resolvedAt) - Date.parse(guessedAt) >= 60_000);
  assert.notEqual(Number(resolvedPrice), Number(entryPrice));
});
