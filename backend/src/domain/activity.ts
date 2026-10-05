import type { PriceItem } from './state';

// Each poller run lasts this long, overlapping the next minute's run by ~10 s, so a late schedule leaves no gap (D2).
// The API starts at most one run per run length (D10).
export const RUN_MS = 70_000;
// All open tabs together record a visit at most this often (D10).
const VISIT_EVERY_MS = 10_000;
// A price older than this means the poller has stopped (D10).
const STOPPED_AFTER_MS = 3_000;
// A run polls if someone visited this recently (D10).
const IN_USE_FOR_MS = 30_000;

// Stored times all have this format, so they compare as strings, in DynamoDB conditions too.
function isoBefore(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

function isMissingOrBefore(time: string | undefined, cutoff: string): boolean {
  return time === undefined || time < cutoff;
}

// A visit is recorded if the stored one is missing or older than this.
export function visitCutoff(now: Date): string {
  return isoBefore(now, VISIT_EVERY_MS);
}

// The poller can be started again if the last start is missing or older than this.
export function startCutoff(now: Date): string {
  return isoBefore(now, RUN_MS);
}

export function shouldRecordVisit(priceItem: PriceItem | undefined, now: Date): boolean {
  return isMissingOrBefore(priceItem?.lastVisitAt, visitCutoff(now));
}

export function shouldStartPoller(priceItem: PriceItem | undefined, now: Date): boolean {
  return (
    isMissingOrBefore(priceItem?.observedAt, isoBefore(now, STOPPED_AFTER_MS)) &&
    isMissingOrBefore(priceItem?.startRequestedAt, startCutoff(now))
  );
}

// Checked at the start of each run. Otherwise the run exits without polling (D10).
export function shouldPoll(priceItem: PriceItem | undefined, guessOpen: boolean, now: Date): boolean {
  return guessOpen || !isMissingOrBefore(priceItem?.lastVisitAt, isoBefore(now, IN_USE_FOR_MS));
}
