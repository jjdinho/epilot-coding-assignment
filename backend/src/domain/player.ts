// Canonical lowercase UUID v4, as crypto.randomUUID() produces (D6).
const PLAYER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 3 to 20 ASCII letters, digits, _ and - (D9).
const ALIAS = /^[A-Za-z0-9_-]{3,20}$/;

export function isValidPlayerId(id: string | undefined): id is string {
  return id !== undefined && PLAYER_ID.test(id);
}

export function isValidAlias(alias: unknown): alias is string {
  return typeof alias === 'string' && ALIAS.test(alias);
}

// Aliases are unique ignoring case, so the key uses the lowercase form (D9).
export function aliasKey(alias: string): string {
  return `ALIAS#${alias.toLowerCase()}`;
}
