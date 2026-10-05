import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { db, PRICE_KEY, TABLE_NAME } from './db';
import { aliasKey, isValidAlias, isValidPlayerId } from './domain/player';
import { buildState, type Player, type Tick } from './domain/state';

type Result = APIGatewayProxyStructuredResultV2;

export async function handler(event: APIGatewayProxyEventV2): Promise<Result> {
  // Checked before any DynamoDB access, so a client can't address the price or alias items (D6).
  const playerId = event.headers['x-player-id'];
  if (!isValidPlayerId(playerId)) return error(400, 'INVALID_PLAYER_ID');

  switch (event.routeKey) {
    case 'GET /state':
      return getState(playerId);
    case 'POST /player':
      return createPlayer(playerId, parseBody(event.body)?.alias);
    default:
      throw new Error(`No handler for route ${event.routeKey}`);
  }
}

async function getState(playerId: string): Promise<Result> {
  const [player, tick] = await Promise.all([getItem<Player>(playerId), getItem<Tick>(PRICE_KEY)]);
  if (!player) return error(404, 'PLAYER_NOT_FOUND');
  return json(200, buildState(player, tick, new Date()));
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
  return json(201, buildState(player, await getItem<Tick>(PRICE_KEY), new Date()));
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
