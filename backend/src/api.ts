import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { db, TABLE_NAME } from './db';
import { isOverdue, isValidDirection, RESOLVE_AFTER_MS, scoreGuess } from './domain/guess';
import { priceHistory, type Trade } from './domain/history';
import { aliasKey, isValidAlias, isValidPlayerId } from './domain/player';
import { isStale, isValidObservedAt, priceKey, shouldFetch } from './domain/price';
import { buildState, type Player, type PriceItem } from './domain/state';
import { resolveGuess, sendResolveMessage } from './guesses';
import { fetchTicker } from './ticker';

type Result = APIGatewayProxyStructuredResultV2;

const TRADES_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000';
// Price items are kept this long for debugging. Nothing depends on them once a guess is made (§5).
const PRICE_EXPIRY_S = 3_600;

// This instance's last recorded price and its last Coinbase attempt (D2). An instance handles one request at a time.
let cachedPrice: PriceItem | undefined;
let lastAttemptAt: string | undefined;

export async function handler(event: APIGatewayProxyEventV2): Promise<Result> {
  // Checked before any DynamoDB access, so a client can't address the price or alias items (D6).
  const playerId = event.headers['x-player-id'];
  if (!isValidPlayerId(playerId)) return error(400, 'INVALID_PLAYER_ID');

  switch (event.routeKey) {
    case 'GET /state':
      return getState(playerId);
    case 'POST /player':
      return createPlayer(playerId, parseBody(event.body)?.alias);
    case 'POST /guess': {
      const body = parseBody(event.body);
      return createGuess(playerId, body?.direction, body?.priceObservedAt);
    }
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

// Fetched from Coinbase at most once a second per instance, and recorded before it's returned (D2). If the fetch or
// the write fails, the cached price, which may be stale or missing. Never a price that wasn't recorded.
async function currentPrice(now: Date): Promise<PriceItem | undefined> {
  if (!shouldFetch(lastAttemptAt, now)) return cachedPrice;
  lastAttemptAt = now.toISOString();
  try {
    const { price, exchangeTime } = await fetchTicker();
    const observedAt = new Date().toISOString();
    const item = { price, exchangeTime, observedAt };
    const expiresAt = Math.floor(Date.parse(observedAt) / 1_000) + PRICE_EXPIRY_S;
    // Awaited, so a guess can name this price as soon as a client has it (D4).
    await db.send(new PutCommand({ TableName: TABLE_NAME, Item: { pk: priceKey(observedAt), ...item, expiresAt } }));
    cachedPrice = item;
  } catch (err) {
    console.error('Price fetch failed', err);
  }
  return cachedPrice;
}

// Backup for a lost message: a guess still open 2 minutes after it was made resolves at the price about to be
// returned (D5). If a late message resolves it at the same moment, the conditional write lets only one through.
async function resolveIfOverdue(playerId: string, player: Player, price: PriceItem | undefined, now: Date): Promise<Player> {
  const { guessDirection: direction, guessEntryPrice: entryPrice, guessedAt } = player;
  if (!direction || !entryPrice || !guessedAt || !isOverdue(guessedAt, now)) return player;
  if (!price || isStale(price.observedAt, now)) return player;
  const delta = scoreGuess(direction, entryPrice, price.price);
  if (delta === null) return player;
  return (await resolveGuess({ playerId, direction, entryPrice, guessedAt }, delta, price.price, price.observedAt)) ?? player;
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

async function createGuess(playerId: string, direction: unknown, priceObservedAt: unknown): Promise<Result> {
  if (!isValidDirection(direction)) return error(400, 'INVALID_DIRECTION');
  // Checked before any DynamoDB access, so a client can only address price items (D4).
  if (!isValidObservedAt(priceObservedAt)) return error(400, 'INVALID_PRICE_OBSERVED_AT');
  const now = new Date();
  // The item's key is its observedAt, so this enforces the 3 s window even for an item TTL hasn't deleted yet (D4, §5).
  if (isStale(priceObservedAt, now)) return error(409, 'PRICE_EXPIRED');

  // Checked before the send, so a refused guess costs no message, resolver run or Coinbase call (D5).
  const [player, priceItem] = await Promise.all([
    getItem<Player>(playerId),
    getItem<PriceItem>(priceKey(priceObservedAt)),
  ]);
  if (!player) return error(404, 'PLAYER_NOT_FOUND');
  if (player.guessedAt) return error(409, 'GUESS_OPEN');
  if (!priceItem) return error(409, 'PRICE_EXPIRED');

  const guessedAt = now.toISOString();
  // Sent before the save, so every saved guess has a message. If the send throws, nothing is saved (D5).
  await sendResolveMessage({ playerId, direction, entryPrice: priceItem.price, guessedAt }, RESOLVE_AFTER_MS / 1_000);
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
        ExpressionAttributeValues: { ':direction': direction, ':entryPrice': priceItem.price, ':guessedAt': guessedAt },
        ReturnValues: 'ALL_NEW',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    return json(201, buildState(Attributes as Player, priceItem, now));
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // The old item comes back only if the player exists, so its guess is what failed the check.
    return err.Item ? error(409, 'GUESS_OPEN') : error(404, 'PLAYER_NOT_FOUND');
  }
}

// Recent trades from Coinbase, for the chart. Needs no player and doesn't touch DynamoDB (D11).
async function getPriceHistory(): Promise<Result> {
  try {
    // Uncompressed: in Lambda's Node 22, a timeout while reading a gzipped body can leave the read pending for good.
    const res = await fetch(TRADES_URL, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`Trades returned ${res.status}`);
    return json(200, { points: priceHistory((await res.json()) as Trade[], new Date()) });
  } catch (err) {
    console.error('Price history failed', err);
    return error(502, 'HISTORY_UNAVAILABLE');
  }
}

// Consistent, so a poll right after POST /player finds the new player, and a guess finds the price its poll returned.
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
