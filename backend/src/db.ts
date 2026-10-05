import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const TABLE_NAME = process.env.TABLE_NAME;
export const PRICE_KEY = 'PRICE#LATEST';
