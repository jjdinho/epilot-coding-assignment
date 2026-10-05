import { describe, expect, it } from 'vitest';
import { shouldPoll, shouldRecordVisit, shouldStartPoller } from './activity';

const now = new Date('2026-10-02T14:48:40.000Z');

describe('shouldRecordVisit', () => {
  it('records a visit when none is stored', () => {
    expect(shouldRecordVisit(undefined, now)).toBe(true);
    expect(shouldRecordVisit({}, now)).toBe(true);
  });

  it('skips it when the stored visit is 10 s old or less', () => {
    expect(shouldRecordVisit({ lastVisitAt: '2026-10-02T14:48:30.000Z' }, now)).toBe(false);
    expect(shouldRecordVisit({ lastVisitAt: '2026-10-02T14:48:39.000Z' }, now)).toBe(false);
  });

  it('records it when the stored visit is older', () => {
    expect(shouldRecordVisit({ lastVisitAt: '2026-10-02T14:48:29.999Z' }, now)).toBe(true);
  });
});

describe('shouldStartPoller', () => {
  const stalePrice = { price: '86024.74', observedAt: '2026-10-02T14:48:36.999Z' };

  it('starts it when the price is missing', () => {
    expect(shouldStartPoller(undefined, now)).toBe(true);
    expect(shouldStartPoller({ lastVisitAt: '2026-10-02T14:48:40.000Z' }, now)).toBe(true);
  });

  it('starts it when the price is more than 3 s old', () => {
    expect(shouldStartPoller(stalePrice, now)).toBe(true);
  });

  it('leaves it when the price is 3 s old or less', () => {
    expect(shouldStartPoller({ ...stalePrice, observedAt: '2026-10-02T14:48:37.000Z' }, now)).toBe(false);
  });

  it('leaves it when the last start was 70 s ago or less', () => {
    expect(shouldStartPoller({ ...stalePrice, startRequestedAt: '2026-10-02T14:47:30.000Z' }, now)).toBe(false);
    expect(shouldStartPoller({ startRequestedAt: '2026-10-02T14:48:39.000Z' }, now)).toBe(false);
  });

  it('starts it again when the last start was more than 70 s ago', () => {
    expect(shouldStartPoller({ ...stalePrice, startRequestedAt: '2026-10-02T14:47:29.999Z' }, now)).toBe(true);
  });
});

describe('shouldPoll', () => {
  it('polls after a visit within 30 s', () => {
    expect(shouldPoll({ lastVisitAt: '2026-10-02T14:48:10.000Z' }, false, now)).toBe(true);
  });

  it('polls while a guess is open, with no recent visit', () => {
    expect(shouldPoll({ lastVisitAt: '2026-10-02T14:48:09.999Z' }, true, now)).toBe(true);
    expect(shouldPoll(undefined, true, now)).toBe(true);
  });

  it('stays idle with no recent visit and no open guess', () => {
    expect(shouldPoll({ lastVisitAt: '2026-10-02T14:48:09.999Z' }, false, now)).toBe(false);
    expect(shouldPoll({}, false, now)).toBe(false);
    expect(shouldPoll(undefined, false, now)).toBe(false);
  });
});
