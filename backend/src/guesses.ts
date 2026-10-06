import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, TABLE_NAME } from './db';
import type { Direction, LastResult } from './domain/guess';
import type { Player } from './domain/state';

// Everything the resolver needs, so it doesn't have to look anything up first (D5).
export interface ResolveMessage {
  playerId: string;
  direction: Direction;
  entryPrice: string;
  guessedAt: string;
}

const sqs = new SQSClient({});

export async function sendResolveMessage(message: ResolveMessage, delaySeconds: number): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(message), DelaySeconds: delaySeconds }),
  );
}

// Applies the score and clears the guess. Undefined if the guess was already resolved or never saved (D5, §5).
export async function resolveGuess(
  message: ResolveMessage,
  delta: 1 | -1,
  price: string,
  resolvedAt: string,
): Promise<Player | undefined> {
  const lastResult: LastResult = {
    direction: message.direction,
    entryPrice: message.entryPrice,
    resolvedPrice: price,
    guessedAt: message.guessedAt,
    resolvedAt,
    delta,
  };
  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: message.playerId },
        UpdateExpression:
          'SET #score = #score + :delta, #lastResult = :lastResult REMOVE #guessDirection, #guessEntryPrice, #guessedAt',
        // Matching guessedAt stops a late or duplicate message from resolving the player's newer guess (§5).
        ConditionExpression: '#guessedAt = :guessedAt',
        ExpressionAttributeNames: {
          '#score': 'score',
          '#lastResult': 'lastResult',
          '#guessDirection': 'guessDirection',
          '#guessEntryPrice': 'guessEntryPrice',
          '#guessedAt': 'guessedAt',
        },
        ExpressionAttributeValues: { ':delta': delta, ':lastResult': lastResult, ':guessedAt': message.guessedAt },
        ReturnValues: 'ALL_NEW',
      }),
    );
    // Logs the alias, not the player ID, which is the player's credential (D6).
    console.log('Guess resolved', JSON.stringify({ alias: Attributes?.alias, score: Attributes?.score, ...lastResult }));
    return Attributes as Player;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return undefined;
    throw err;
  }
}
