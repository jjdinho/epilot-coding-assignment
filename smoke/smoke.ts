// Smoke test against the deployed API: API_URL=<ApiUrl output> npm run smoke
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

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
