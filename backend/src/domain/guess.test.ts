import { describe, expect, it } from 'vitest';
import { isOverdue, isValidDirection, scoreGuess } from './guess';

describe('isValidDirection', () => {
  it.each(['UP', 'DOWN'])('accepts %s', (direction) => {
    expect(isValidDirection(direction)).toBe(true);
  });

  it.each(['up', 'SIDEWAYS', '', 1, undefined])('rejects %s', (direction) => {
    expect(isValidDirection(direction)).toBe(false);
  });
});

describe('scoreGuess', () => {
  it.each([
    ['UP', '86010.01', 1],
    ['UP', '86009.99', -1],
    ['DOWN', '86009.99', 1],
    ['DOWN', '86010.01', -1],
  ] as const)('%s from 86010.00 to %s → %i', (direction, price, delta) => {
    expect(scoreGuess(direction, '86010.00', price)).toBe(delta);
  });

  it.each(['UP', 'DOWN'] as const)('does not resolve %s at the same price', (direction) => {
    expect(scoreGuess(direction, '86010.00', '86010.00')).toBeNull();
  });

  it('compares prices as numbers, not strings', () => {
    expect(scoreGuess('UP', '86010.00', '86010')).toBeNull();
    expect(scoreGuess('UP', '86096.25000000', '86096.25')).toBeNull();
    expect(scoreGuess('UP', '9999.99', '10000.00')).toBe(1);
  });
});

describe('isOverdue', () => {
  const guessedAt = '2026-10-02T14:48:33.000Z';

  it('is not overdue exactly 2 minutes after the guess', () => {
    expect(isOverdue(guessedAt, new Date('2026-10-02T14:50:33.000Z'))).toBe(false);
  });

  it('is overdue just over 2 minutes after the guess', () => {
    expect(isOverdue(guessedAt, new Date('2026-10-02T14:50:33.001Z'))).toBe(true);
  });
});
