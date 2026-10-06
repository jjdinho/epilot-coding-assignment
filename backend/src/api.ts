import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { db, TABLE_NAME } from './db';
import { isOverdue, isValidDirection, RESOLVE_AFTER_MS, scoreGuess } from './domain/guess';
import { priceHistory } from './domain/history';
import { aliasKey, isValidAlias, isValidPlayerId } from './domain/player';
import { isStale, shouldFetch } from './domain/price';
import { buildState, type Player, type Price } from './domain/state';
import { fetchTicker, fetchTrades } from './coinbase';
import { resolveGuess, sendResolveMessage } from './guesses';

type Result = APIGatewayProxyStructuredResultV2;

// This instance's last fetched price and its last Coinbase attempt (D2). An instance handles one request at a time.
let cachedPrice: Price | undefined;
let lastAttemptAt: string | undefined;

export async function handler(event: APIGatewayProxyEventV2): Promise<Result> {
  // Checked before any DynamoDB access, so a client can't address an alias item (D6).
  const playerId = event.headers['x-player-id'];
  if (!isValidPlayerId(playerId)) return error(400, 'INVALID_PLAYER_ID');

  switch (event.routeKey) {
    case 'GET /state':
      return getState(playerId);
    case 'POST /player':
      return createPlayer(playerId, parseBody(event.body)?.alias);
    case 'POST /guess':
      return createGuess(playerId, parseBody(event.body)?.direction);
    case 'GET /price/history':
      return getPriceHistory();
    default:
      throw new Error(`No handler for route ${event.routeKey}`);
  }
}

async function getState(playerId: string): Promise<Result> {
  const now = new Date();
  const [player, price] = await Promise.all([getItem<Player>(playerId), currentPrice(now)]);
  if (!player) return error(404, 'PLAYER_NOT_FOUND');
  return json(200, buildState(await resolveIfOverdue(playerId, player, price, now), price, now));
}

// Fetched from Coinbase at most once a second per instance (D2). If the fetch fails, the cached price, which may be
// stale or missing.
async function currentPrice(now: Date): Promise<Price | undefined> {
  if (!shouldFetch(lastAttemptAt, now)) return cachedPrice;
  lastAttemptAt = now.toISOString();
  try {
    const value = await fetchTicker();
    cachedPrice = { value, observedAt: new Date().toISOString() };
  } catch (err) {
    console.error('Price fetch failed', err);
  }
  return cachedPrice;
}

// Backup for a lost message: a guess still open 2 minutes after it was made resolves at the price about to be
// returned (D5). If a late message resolves it at the same moment, the conditional write lets only one through.
async function resolveIfOverdue(playerId: string, player: Player, price: Price | undefined, now: Date): Promise<Player> {
  const { guessDirection: direction, guessEntryPrice: entryPrice, guessedAt } = player;
  if (!direction || !entryPrice || !guessedAt || !isOverdue(guessedAt, now)) return player;
  if (!price || isStale(price.observedAt, now)) return player;
  const delta = scoreGuess(direction, entryPrice, price.value);
  if (delta === null) return player;
  return (await resolveGuess({ playerId, direction, entryPrice, guessedAt }, delta, price.value, price.observedAt)) ?? player;
}

async function createPlayer(playerId: string, alias: unknown): Promise<Result> {
  if (!isValidAlias(alias)) return error(400, 'INVALID_ALIAS');

  const player = { alias, score: 0 };
  // Both items are written together, each only if new, so an alias can't be claimed twice (D9).
  const putIfNew = (Item: Record<string, unknown>) => ({
    Put: {
      TableName: TABLE_NAME,
      Item,
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    },
  });
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [putIfNew({ pk: playerId, ...player }), putIfNew({ pk: aliasKey(alias), playerId })],
      }),
    );
  } catch (err) {
    if (!(err instanceof TransactionCanceledException)) throw err;
    const [playerReason, aliasReason] = err.CancellationReasons ?? [];
    if (playerReason?.Code === 'ConditionalCheckFailed') return error(409, 'PLAYER_EXISTS');
    if (aliasReason?.Code === 'ConditionalCheckFailed') return error(409, 'ALIAS_TAKEN');
    throw err;
  }
  const now = new Date();
  return json(201, buildState(player, await currentPrice(now), now));
}

async function createGuess(playerId: string, direction: unknown): Promise<Result> {
  if (!isValidDirection(direction)) return error(400, 'INVALID_DIRECTION');

  // The entry price is whatever this instance holds when the guess arrives, so the client can't choose it (D4).
  const [player, price] = await Promise.all([getItem<Player>(playerId), currentPrice(new Date())]);
  // Taken after the fetch, so the guess isn't timed before its entry price.
  const now = new Date();
  // Checked before the send, so a refused guess costs no message or resolver run (D5).
  if (!player) return error(404, 'PLAYER_NOT_FOUND');
  if (player.guessedAt) return error(409, 'GUESS_OPEN');
  if (!price || isStale(price.observedAt, now)) return error(503, 'PRICE_STALE');

  const guessedAt = now.toISOString();
  // Sent before the save, so every saved guess has a message. If the send throws, nothing is saved (D5).
  await sendResolveMessage({ playerId, direction, entryPrice: price.value, guessedAt }, RESOLVE_AFTER_MS / 1_000);
  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: playerId },
        UpdateExpression: 'SET #guessDirection = :direction, #guessEntryPrice = :entryPrice, #guessedAt = :guessedAt',
        // One open guess at a time, and only for an existing player. Fails only if another request saved a guess
        // since the read above. This request's message then finds a different guessedAt and does nothing (§5).
        ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#guessedAt)',
        ExpressionAttributeNames: {
          '#pk': 'pk',
          '#guessDirection': 'guessDirection',
          '#guessEntryPrice': 'guessEntryPrice',
          '#guessedAt': 'guessedAt',
        },
        ExpressionAttributeValues: { ':direction': direction, ':entryPrice': price.value, ':guessedAt': guessedAt },
        ReturnValues: 'ALL_NEW',
      }),
    );
    // The entry price is the response's price, so the page shows the number the guess was made at (D4).
    return json(201, buildState(Attributes as Player, price, now));
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    return error(409, 'GUESS_OPEN');
  }
}

// Recent trades from Coinbase, for the chart. Needs no player and doesn't touch DynamoDB (D11).
async function getPriceHistory(): Promise<Result> {
  try {
    return json(200, { points: priceHistory(await fetchTrades(), new Date()) });
  } catch (err) {
    console.error('Price history failed', err);
    return error(502, 'HISTORY_UNAVAILABLE');
  }
}

// Consistent, so a poll right after POST /player finds the new player.
async function getItem<T>(pk: string): Promise<T | undefined> {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { pk }, ConsistentRead: true }));
  return Item as T | undefined;
}

function parseBody(body: string | undefined): Record<string, unknown> | undefined {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return undefined;
  }
}

function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function error(statusCode: number, code: string): Result {
  return json(statusCode, { error: code });
}
