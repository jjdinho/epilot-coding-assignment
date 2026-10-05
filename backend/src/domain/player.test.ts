import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aliasKey, isValidAlias, isValidPlayerId } from './player';

describe('isValidPlayerId', () => {
  it('accepts crypto.randomUUID() output', () => {
    expect(isValidPlayerId(randomUUID())).toBe(true);
  });

  it.each([
    ['uppercase', randomUUID().toUpperCase()],
    ['version 1', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['version 7', '01890a5d-ac96-774b-bcce-b302099a8057'],
    ['the price key', 'PRICE#LATEST'],
    ['an alias key', 'ALIAS#x'],
    ['a guessable ID', '1'],
    ['the empty string', ''],
    ['a missing header', undefined],
  ])('rejects %s', (_, id) => {
    expect(isValidPlayerId(id)).toBe(false);
  });
});

describe('isValidAlias', () => {
  it.each(['abc', 'a'.repeat(20), 'Satoshi_99', 'moon-boy'])('accepts %s', (alias) => {
    expect(isValidAlias(alias)).toBe(true);
  });

  it.each([
    ['2 characters', 'ab'],
    ['21 characters', 'a'.repeat(21)],
    ['a space', 'sat oshi'],
    ['a Cyrillic а', 'sаtoshi'],
    ['other punctuation', 'satoshi!'],
    ['a non-string', 123],
    ['a missing alias', undefined],
  ])('rejects %s', (_, alias) => {
    expect(isValidAlias(alias)).toBe(false);
  });
});

describe('aliasKey', () => {
  it('uses the lowercase form', () => {
    expect(aliasKey('Satoshi')).toBe('ALIAS#satoshi');
  });
});
