# Slice 5 spec — On-demand price and delayed resolution

Status: 6 October 2026. A self-contained spec for one PR, to hand to an implementing agent. It replaces the poller built in slices 1–3.

## Before you start

- Read [design.md](design.md) in full. D2, D4, D5, D8, D10 and §3, §5–§7 were rewritten on 6 October for this slice. Where this spec is silent, the design wins. If the design is ambiguous on something this spec doesn't settle, ask rather than guess.
- [slices.md](slices.md) "How to use this doc" and "Conventions for every slice" apply: tests first for domain logic, handlers stay thin and aren't unit-tested, deploy and verify before the PR. Where this spec and slices.md disagree, this spec wins.
- Branch from the latest `main`. Run `npm install` and `npm test` first for a baseline (67 tests passed on 6 October).
- Deploy with the `jjdinho` AWS profile: `AWS_PROFILE=jjdinho npm run deploy`. Read [Deploy order](#deploy-order) before the first deploy. If AWS reports an expired session, ask the owner to sign in again rather than trying another profile.

## Goal

No poller and no schedule. The API fetches the price when a page asks for it and records every price it fetches. A guess names the price on the player's screen, and its entry price is exactly that price. Each guess resolves from its own SQS message, delayed 60 seconds. For the player, the game plays as before, except that the entry price always matches the screen.

## Why, in short

- **Simpler.** The poller needed a one-minute schedule, 70-second looping runs, visit tracking, start requests and an index of open guesses (old D2, D10). A delayed message per guess and a price fetched on request replace all of it.
- **Fairer to the eye.** The entry price used to be the latest price the server held, up to a second away from the screen. Now it's the price on screen, honored for up to 3 seconds (D4).

## What changes

| | |
|---|---|
| **Remove** | `backend/src/poller.ts`. `backend/src/domain/activity.ts` and its test. `dueCutoff` and its test. The poller Lambda, its EventBridge rule, the API's permission to invoke it and `POLLER_FUNCTION_NAME`. The `open-guesses` index. The `guessStatus` attribute. Visit tracking (`lastVisitAt`, `startRequestedAt`). Reads and writes of `PRICE#LATEST`, and `PRICE_KEY`. The `PRICE_STALE` error. The `@aws-sdk/client-lambda` dependency. |
| **Add** | An SQS queue. A resolver Lambda (`backend/src/resolver.ts`). Price items `PRICE#<observedAt>` with a TTL. The `@aws-sdk/client-sqs` dependency. Two shared modules used by the API and the resolver. |
| **Change** | `GET /state` gets its price on demand and resolves overdue guesses as a backup. `POST /guess` takes `priceObservedAt`, checks the player and the price, sends the message, then saves the guess. Frontend: the guess body and two messages. The smoke test. Comments and README lines that mention the poller. |

## Constants

| Name | Value | Meaning |
|---|---|---|
| `PRICE_CACHE_MS` | 1,000 | The API tries Coinbase at most once per this interval per instance, counted from the last attempt whether or not it succeeded (D2) |
| `STALE_AFTER_MS` | 3,000 | Was 5,000. A price older than this is stale, and a guess can't name it (D4, D8) |
| `RESOLVE_AFTER_MS` | 60,000 | Exists. The first message's delay, as 60 seconds |
| `RECHECK_DELAY_S` | 2 | Delay of a re-sent message when the price hasn't moved (D5) |
| `RETRY_DELAY_S` | 10 | Delay of a re-sent message when Coinbase couldn't be reached, so an outage doesn't turn every open guess into a Coinbase call every 2 s (D5) |
| `BACKUP_AFTER_MS` | 120,000 | `GET /state` resolves a guess that's been open longer than this (D5) |
| Price item expiry | 1 hour | `expiresAt` = `observedAt` + 3,600 s, in epoch seconds (§5) |

## Scope

### 1. Domain (pure, tests first)

- `domain/price.ts`
  - `isStale(observedAt, now)`: 3 s instead of 5 s.
  - `isValidObservedAt(value): value is string`: true only for a string that parses to a valid date and that `new Date(value).toISOString()` reproduces exactly. Check `typeof value === 'string'` and `Number.isNaN(date.getTime())` before the round trip: `toISOString()` throws a `RangeError` on an invalid date. This guards the price item key the same way the player ID check does (D4, D6).
  - `shouldFetch(lastAttemptAt: string | undefined, now)`: true if the instance hasn't tried Coinbase yet, or its last attempt is 1 s old or more. Counted from the attempt, not the success, so a failing Coinbase is still tried at most once a second per instance (D2).
  - `priceKey(observedAt)`: `PRICE#<observedAt>`.
- `domain/guess.ts`
  - `isOverdue(guessedAt, now)`: true when more than 2 minutes have passed since `guessedAt`.
  - Remove `dueCutoff`.
- `domain/state.ts`. The price type becomes `{ price, exchangeTime, observedAt }`, with no visit fields. `buildState` still returns `price: null` when there's no price, and otherwise `{ value, observedAt, stale }`.

### 2. Shared backend modules

The API and the resolver both use these. They do I/O, so they aren't unit-tested.

- `backend/src/ticker.ts`: `fetchTicker()` fetches `https://api.exchange.coinbase.com/products/BTC-USD/ticker` and returns `{ price, exchangeTime }`, with `exchangeTime` taken from Coinbase's `time`.
  - Use a 2 s `AbortSignal.timeout`, and throw on a non-OK status.
  - Send `accept-encoding: identity`. In Lambda's Node 22, a timeout that fires while a gzipped body is being read can leave the read pending for good, as noted in `api.ts`'s history route.
- `backend/src/guesses.ts`
  - `ResolveMessage`: `{ playerId, direction, entryPrice, guessedAt }`.
  - `sendResolveMessage(message, delaySeconds)`: SQS `SendMessage` to `process.env.QUEUE_URL`, with the message as the JSON body.
  - `resolveGuess(message, delta, price, resolvedAt)`: the conditional write from today's poller `resolve()`, moved here.
    - `SET score = score + :delta, lastResult = :lastResult`.
    - `REMOVE guessDirection, guessEntryPrice, guessedAt`.
    - Condition: `#guessedAt = :guessedAt`.
    - On success, log `Guess resolved` with the alias, the new score and `lastResult`, never the player ID (D6), and return the updated player.
    - On `ConditionalCheckFailedException`, return `undefined`. That means the guess was already resolved or never saved.

### 3. API Lambda (`api.ts`)

- **Price on demand (D2).** Keep the last fetched price and the time of the last attempt in module-scope variables and add `currentPrice(now)`.
  - If `shouldFetch(lastAttemptAt, now)` is false, return the cached price.
  - Otherwise set `lastAttemptAt = now.toISOString()`, `fetchTicker()`, take `observedAt = new Date().toISOString()`, and `PutItem` the price item `{ pk: priceKey(observedAt), price, exchangeTime, observedAt, expiresAt }`. Wait for the write, then update the cache.
  - If the fetch or the write fails, log it and return the cached price unchanged. It may be stale, or `undefined` on a new instance. The attempt still counts, so the next request within a second answers from the cache at once instead of waiting on Coinbase again.
  - Invariant: **every price the API returns has been recorded.** Never return a fetched price whose write failed.
- **`GET /state`.**
  - Read the player and `currentPrice(now)` in parallel. 404 as today.
  - **Backup (D5).** Resolve here only if the player has an open guess, `isOverdue(guessedAt, now)` holds, and the price exists and isn't stale. Compute `scoreGuess`. If it isn't `null`, call `resolveGuess` with `resolvedAt` = the price's `observedAt`, and build the state from the returned player if there is one.
  - Remove `keepPollerRunning`, `setTimeIfBefore` and the Lambda client.
- **`POST /player`.** Unchanged, except the state it returns uses `currentPrice(now)`.
- **`POST /guess`**, in this order:
  1. Invalid direction: 400 `INVALID_DIRECTION`.
  2. `priceObservedAt` from the body. `!isValidObservedAt`: 400 `INVALID_PRICE_OBSERVED_AT`.
  3. `isStale(priceObservedAt, now)`: 409 `PRICE_EXPIRED`, without touching DynamoDB. This is what enforces the 3 s window: the item's `observedAt` is its key, so an expired item that TTL hasn't deleted yet fails here (§5).
  4. Consistent `GetItem` of the player and of `priceKey(priceObservedAt)`, in parallel. No player: 404 `PLAYER_NOT_FOUND`. Player has `guessedAt`: 409 `GUESS_OPEN`. Price item missing: 409 `PRICE_EXPIRED`. These checks come before the send, so a refused guess doesn't cost a message, a resolver run and a Coinbase call (D5).
  5. `guessedAt = now.toISOString()`. `sendResolveMessage({ playerId, direction, entryPrice: item.price, guessedAt }, 60)`. **Before** the save (D5). If the send throws, let it: the request fails with a 500, nothing is saved, and the player can try again.
  6. `UpdateItem` the player. `SET guessDirection, guessEntryPrice, guessedAt`, with the condition `attribute_exists(pk) AND attribute_not_exists(guessedAt)`. Keep `ReturnValuesOnConditionCheckFailure: ALL_OLD` to tell 404 from 409 `GUESS_OPEN`, as today. Step 4 makes a failure here rare: two tabs guessing at the same moment, where the loser's message later finds a guess with a different `guessedAt` (§5).
  7. 201 with the state, using the guessed price item as `price`.
- `GET /price/history` is unchanged.

### 4. Resolver Lambda (`backend/src/resolver.ts`)

SQS handler, batch size 1. For the message:

1. `fetchTicker()`. If it throws, log `Ticker failed` with the error, `sendResolveMessage(message, RETRY_DELAY_S)`, and return. The longer delay keeps an outage from turning every open guess into a Coinbase call every 2 s. A guess may then resolve up to 10 s after Coinbase recovers.
2. `resolvedAt = new Date().toISOString()`. `delta = scoreGuess(direction, entryPrice, price)`. If `null`, the price hasn't moved: re-send with `RECHECK_DELAY_S` and return. Don't log re-sends.
3. `resolveGuess(message, delta, price, resolvedAt)`. Whether it resolves or returns `undefined`, the message is done.

Return normally only in those cases. Let any other error throw, including a failed re-send, so SQS delivers the message again after its visibility timeout (D5). Never catch-and-drop.

### 5. Infra (`infra/app.ts`)

- **Table.** Remove `globalSecondaryIndexes`. Add `timeToLiveAttribute: 'expiresAt'`.
- **Remove** the poller, its `Rule`, `grantInvoke` and `POLLER_FUNCTION_NAME`, and the imports they leave unused.
- **Queue.** `new Queue(this, 'ResolveQueue')` with its defaults: 30 s visibility timeout, 4-day retention, and no dead-letter queue (§10). Comment why there's no dead-letter queue.
- **Lambda helper.** Add `QUEUE_URL: queue.queueUrl` to the shared `environment`, so create the queue before the helper.
- **Resolver.** `lambda('Resolver', 'resolver.ts', { memorySize: 256, timeout: Duration.seconds(10) })`.
  - Grants: `table.grantReadWriteData(resolver)` and `queue.grantSendMessages(resolver)` for re-sends.
  - `resolver.addEventSource(new SqsEventSource(queue, { batchSize: 1 }))`.
  - The 10 s timeout must stay below the queue's 30 s visibility timeout.
  - 256 MB matches the API: at 128 MB, cold Coinbase calls came close to the 2 s timeout.
- **API.** `queue.grantSendMessages(apiHandler)`. Memory and timeout stay at 256 MB and 3 s. The 2 s ticker timeout still bounds every route.
- **Dependencies.** `npm uninstall @aws-sdk/client-lambda -w backend`, then `npm install @aws-sdk/client-sqs -w backend`, matching the other SDK versions. `NodejsFunction` externalizes `@aws-sdk/*`, and Lambda's Node 22 runtime provides it.

### 6. Frontend

- `POST /guess` body: `{ direction, priceObservedAt: price.observedAt }`, sent exactly as received from the server.
- `GUESS_ERRORS`: replace `PRICE_STALE` with `PRICE_EXPIRED: 'That price has expired. Try again.'`.
- When `price` is `null`, show "Price feed unavailable" instead of "waiting for the first price". It's now only `null` when the API couldn't reach Coinbase.
- Skip a poll while the previous one is still in flight. A slow Coinbase then slows the tab's polling to match, instead of stacking requests that spread across API instances, each fetching for itself (D2).
- No other behavior changes. Hidden tabs still stop polling, and the chart is unchanged.

### 7. Smoke test

The full sequence, in order. New and changed steps are marked.

1. Bad player ID → 400 `INVALID_PLAYER_ID`.
2. New player ID → `GET /state` 404.
3. `GET /price/history` → points from the last minute, oldest first.
4. `POST /player` → 201, score 0.
5. Same alias, other case, from another new ID → 409 `ALIAS_TAKEN`.
6. Same ID again → 409 `PLAYER_EXISTS`.
7. **Changed.** `GET /state` → the alias, score 0, and a price that isn't stale, on the first call. Remove the wait loop: there's no poller to start.
8. **Changed.** Guess from an unknown player ID, with the `priceObservedAt` of step 7's price, straight after it → 404 `PLAYER_NOT_FOUND`. An unknown player can't get a price of its own, so take it from the real player's state.
9. Bad direction → 400 `INVALID_DIRECTION`.
10. **New.** Missing `priceObservedAt`, and one without milliseconds (`2026-10-02T14:48:33Z`) → 400 `INVALID_PRICE_OBSERVED_AT`.
11. **New.** A `priceObservedAt` the server never recorded (`new Date().toISOString()` on the smoke machine) → 409 `PRICE_EXPIRED`.
12. **New.** A recorded price more than 3 s old → 409 `PRICE_EXPIRED`. Take it from `GET /state`, then wait 3.5 s before guessing.
13. **Changed.** Guess with the `observedAt` of a fresh `GET /state` price → 201. `openGuess.entryPrice` equals that `price.value` exactly, as strings. This is the slice's key property.
14. Second guess, with a fresh price → 409 `GUESS_OPEN`.
15. **Changed.** The guess resolves within 100 s of the guess. The backup in `GET /state` can't act before 2 minutes (D5), so only the resolver can pass this step, and a resolver with a missing grant or a wrong queue URL fails it. The score moves by `lastResult.delta`. `resolvedAt − guessedAt ≥ 60 s`, and `resolvedPrice ≠ entryPrice`. Change the wait message to name the resolver.

### 8. Clean-up

- Comments that mention the poller, ticks or visits now describe the new design. Afterwards, `grep -rniE 'poller|\bticks?\b|visit|PRICE#LATEST|PRICE_STALE|open-guesses|guessStatus|dueCutoff' backend frontend/src infra/app.ts smoke README.md` should find only intended text. The word boundaries keep `ticker` out of the matches. Two intended matches: `player.test.ts` rejects `PRICE#LATEST` as a player ID, and `App.tsx` says the countdown ticks once a second. Both stay.
- README. Only the lines that mention the poller: the backend bullet, and the two smoke test notes. The full README is slice 6.
- `backend/src/db.ts`: remove `PRICE_KEY`.

## Tests first

Write these tests before the code. Each one should fail first.

- `isStale`: fresh at exactly 3 s old, stale just over. Update the existing two tests.
- `isValidObservedAt`:
  - Accepts `new Date().toISOString()` output.
  - Rejects `2026-10-02T14:48:33Z` (no milliseconds), `2026-10-02T14:48:33.120+00:00`, `2026-02-30T00:00:00.000Z` (no such day; Node rolls it over to 2 March, so the round trip differs), `PRICE#LATEST` and `''` (invalid dates, which must return false rather than throw), a number and `undefined`.
- `shouldFetch`: no attempt yet → true. Attempted 999 ms ago → false. Attempted exactly 1,000 ms ago → true.
- `priceKey`: `PRICE#` plus the timestamp.
- `isOverdue`: exactly 120 s after `guessedAt` → false. 120.001 s → true.
- `buildState`: update the tests that use visit fields or "tick" wording. A missing price gives `price: null`. A price 3.001 s old is `stale`.
- `scoreGuess` keeps its tests. Delete the `dueCutoff` and `activity` tests.

## Deploy order

1. **No guess may be open from the old design.** Its guess has no message, so after the deploy only the backup could resolve it, and only when that player returns. Before deploying, check that the `open-guesses` index is empty:
   ```sh
   TABLE=$(AWS_PROFILE=jjdinho aws cloudformation describe-stack-resources --stack-name BtcUpDown --region eu-north-1 \
     --query "StackResources[?ResourceType=='AWS::DynamoDB::GlobalTable'].PhysicalResourceId" --output text)
   AWS_PROFILE=jjdinho aws dynamodb scan --table-name "$TABLE" --index-name open-guesses --select COUNT --region eu-north-1
   ```
   If the count isn't 0, wait a minute for the old poller to resolve them, then check again.
2. **Deploy.** CloudFormation may refuse to remove the index and enable TTL in the same table update. If it does, deploy without the TTL line first, then again with it. Say in the PR which happened.
3. **Leave the old `PRICE#LATEST` item in the table.** Nothing reads it, and slices.md says to change AWS only through the stack.

## Checks

Run against the deployed stack, after `npm test`, `npm run build` and `npm run synth` pass.

- [ ] `API_URL=<ApiUrl> npm run smoke` passes.
- [ ] The stack has no poller Lambda and no EventBridge rule. `describe-table` lists no secondary index, and `describe-time-to-live` shows TTL enabled on `expiresAt`.
- [ ] In a browser, the price updates about once a second. Click Up: the open-guess panel's entry price equals the price on screen at the click.
- [ ] The score changes 60–65 s after the guess. The resolver's log shows `Guess resolved` for that alias.
- [ ] Guess, close the tab, come back after 2 minutes: the score has already changed (D5).
- [ ] Two tabs show the same open guess and countdown, and neither can guess again.
- [ ] Idle. With no tab open and no guess open for 5 minutes, neither Lambda is invoked: no `START` lines in either log group in that window.
- [ ] **Backup.** Guess in the browser, then purge the queue straight away with `aws sqs purge-queue`. That's the one AWS change outside the stack this spec allows. Keep the page open. The guess stays open past 60 s and resolves soon after 2 minutes. The **API's** log shows `Guess resolved`, not the resolver's. If the resolver resolved it at about 60 s, the purge came too late: try again.
- [ ] `Max Memory Used` in the REPORT lines of both Lambdas stays under 80% of their memory size.

## Not in this slice

- The full README and its trade-offs. That's slice 6.
- A dead-letter queue, a shared price cache, or a concurrency cap on the resolver's event source (§10). All answer a scale the app isn't at.
- Changes to `GET /price/history`, the chart, aliases or routes.
- Deleting old data by hand.

## PR

Title: `Slice 5: On-demand price and delayed resolution`. In the description:

- List each check above with its result.
- Give the pre-deploy count of open guesses.
- Say whether the deploy needed two steps.
- Mention anything you did beyond this spec, and why.
