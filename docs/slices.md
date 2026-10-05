# BTC Up/Down — Implementation Slices

Status: 5 October 2026. Companion to [design.md](design.md). The design says what to build and why. This doc gives the build order, settles the design's open items (§8), and fills in details it leaves to implementation.

## How to use this doc

- Read [design.md](design.md) in full first. Where this doc is silent, the design wins. If the design is ambiguous on something this doc doesn't settle, ask rather than guess.
- One slice per PR, in order, branched from the latest `main`. Start a slice only after the previous one has merged. There is a single deployed stack, so only one slice can be in progress at a time.
- Stay inside the slice. Don't build pieces of later slices early, even when it looks convenient.
- Write tests first for domain logic: a failing unit test, then the code that makes it pass.
- **Deploy and verify before opening the PR.** `npm run deploy` deploys your branch to the stack. Then run the smoke test and the slice's checks against it. Use the AWS credentials in your environment. If there are none, or you can't tell which profile to use, ask. Make AWS changes only through the stack.
- PR title `Slice N: <name>`. In the description, list the slice's checks with the result of each.

Each slice lists its **Scope**, the **Tests first** to write before the code, and the **Checks** to run against the deployed stack. Before opening any PR:

- `npm test`, `npm run build` and `npm run synth` pass.
- The branch is deployed and `npm run smoke` passes against it.
- Every check in the slice is done.

For the UI checks, use a headless browser (Playwright through `npx` is fine). For the poller checks, read its CloudWatch logs. Keep one-off check scripts out of the repo; the smoke test is the only one that belongs there. If a check can't be done headless, say so in the PR and leave it for the owner. If the PR changes after review, redeploy and rerun the checks the change affects.

## Settled decisions (design §8)

| Topic | Decision |
|---|---|
| Language | TypeScript everywhere, Node 22 |
| Infrastructure | AWS CDK v2, one stack |
| Frontend | Vite + React, a handful of components |
| Hosting | S3 + CloudFront, private bucket with origin access control |
| Region | `eu-north-1` |
| Tests | Vitest unit tests for pure domain logic. One smoke test against the deployed API. No DynamoDB Local. Handlers stay thin and aren't unit-tested; the smoke test covers them. |
| Tick cadence | One per second |

## Repository layout

Slice 1 sets this up. Later slices extend it.

```
package.json      npm workspaces; root scripts below
backend/
  src/domain/     pure functions: every rule that can be one lives here, with its tests
  src/api.ts      API Lambda: one handler for all routes, switching on event.routeKey
  src/poller.ts   poller Lambda
frontend/         Vite + React
infra/            CDK app: one stack
smoke/            smoke test against the deployed API
README.md
```

Root scripts:

- `npm test`: all unit tests.
- `npm run build`: typecheck everything and build the frontend.
- `npm run synth`: `cdk synth`.
- `npm run deploy`: build, then `cdk deploy`.
- `npm run smoke`: the smoke test, against the API URL in `API_URL`.

## Conventions for every slice

- **Table.** One table, on-demand billing, string partition key `pk`, no sort key. Key values: `<playerId>`, `PRICE#LATEST`, `ALIAS#<lowercase alias>` (§5).
- **Expressions.** Use `ExpressionAttributeNames` (`#score`, `#price`, …) for every attribute in every expression. DynamoDB has hundreds of reserved words, and that error only shows up after deploy.
- **Timestamps.** Always `new Date().toISOString()`. The `open-guesses` sort key is compared as a string, so every stored timestamp needs the same format. Mixing `…:33Z` and `…:33.000Z` breaks the comparison. The one exception is `exchangeTime`, stored as Coinbase sends it.
- **Prices.** Stored and returned as the exchange's decimal strings. Compare them as numbers, never as strings: trades come back as `"86096.25000000"`, the ticker as `"86096.25"`. Format for display on the client.
- **Errors.** JSON body `{ "error": "<CODE>" }`. §6 names two codes; the full set is:

  | Status | Code | When |
  |---|---|---|
  | 400 | `INVALID_PLAYER_ID` | `X-Player-Id` missing or not a lowercase UUID v4 (D6) |
  | 400 | `INVALID_ALIAS` | Alias breaks the D9 rules |
  | 400 | `INVALID_DIRECTION` | Not `UP` or `DOWN` |
  | 404 | `PLAYER_NOT_FOUND` | No player for this ID |
  | 409 | `PLAYER_EXISTS` | This ID already has a player |
  | 409 | `ALIAS_TAKEN` | Another player holds the alias |
  | 409 | `GUESS_OPEN` | The player already has an open guess |
  | 503 | `PRICE_STALE` | Latest tick missing or older than 5 s (D8) |
  | 502 | `HISTORY_UNAVAILABLE` | Coinbase trades unreachable (D11) |

- **API URL in the frontend.** The stack writes `config.json` (`{ "apiUrl": "…" }`) into the site bucket with `BucketDeployment` and `Source.jsonData`, which resolves the URL at deploy time. The frontend fetches it on startup. The frontend build then doesn't depend on the deploy, and one `cdk deploy` is enough.
- **CORS.** The HTTP API allows any origin, `GET` and `POST`, and the `Content-Type` and `X-Player-Id` headers. No cookies are involved (D6), so a wildcard origin is fine.
- **Lambdas.** `NodejsFunction`, Node 22, ARM64. Poller at 192 MB (D10): at 128 MB it peaked at 113 MB, before slice 2 added the resolve step. Add `esbuild` as a dev dependency so bundling doesn't need Docker. Use the built-in `fetch` with a timeout (`AbortSignal.timeout`) for Coinbase calls.
- **Stack environment.** Region `eu-north-1`, account from `CDK_DEFAULT_ACCOUNT`, no context lookups, so `cdk synth` runs without AWS credentials. Stack outputs: `SiteUrl` and `ApiUrl`.

## Slice 1 — Join and watch the price

**Goal.** A deployed page where a new visitor picks an alias and then sees their score (0) and a BTC/USD price that updates every second.

**Scope.**

- Repo layout, root scripts, TypeScript and Vitest setup.
- Stack: table, poller Lambda on a one-minute EventBridge rule (D2), HTTP API with the API Lambda, site bucket and CloudFront, `config.json`, outputs.
- Poller (D2, D3). Loop for about 70 s. Each tick fetches the ticker with a ~2 s timeout, then `UpdateItem`s `PRICE#LATEST`, setting only `price`, `exchangeTime` and `observedAt` (§5). It then waits until one second after the tick began, so a slow fetch doesn't stretch the cadence. A failed fetch is logged and the tick skipped. Lambda timeout about 90 s. Log run start, run end and errors, not ticks. No resolution yet.
- `X-Player-Id` check on every route, before any DynamoDB access (D6).
- `POST /player` (D9, §6). Validate the alias. One `TransactWriteItems`: put the player item (`alias` as typed, `score` 0) and the alias item (`playerId`), each conditional on `attribute_not_exists(pk)`. On cancellation, `CancellationReasons` says which condition failed. Player item → `PLAYER_EXISTS` (check this one first), alias item → `ALIAS_TAKEN`. 201 with the state.
- `GET /state` (§6). Read the player and `PRICE#LATEST` in parallel. 404 if no player. `price.stale` is true when `observedAt` is more than 5 s old (D8). `price` is `null` until the first tick exists, right after the first deploy. `openGuess` and `lastResult` are always `null` in this slice.
- Build the state response in one function. `POST /player` and later `POST /guess` return the same shape.
- Frontend. On first load, generate `crypto.randomUUID()`, keep it in local storage, and send it as `X-Player-Id` on every request. Poll `GET /state` every second. On 404, stop polling and show the alias form. On 201, resume polling. Show `ALIAS_TAKEN` next to the form. On `PLAYER_EXISTS`, resume polling. Show alias, score and price, plus the price's age when it's stale. Never render the player ID (D6, D9).
- README: what the app is, local setup, `npm test`, one-time `cdk bootstrap`, `npm run deploy`, `npm run smoke`.
- Smoke test, first part:
  - Bad player ID → 400 `INVALID_PLAYER_ID`.
  - New random ID → `GET /state` 404.
  - `POST /player` with a random alias (`smoke_` plus 8 hex characters) → 201, score 0.
  - Same alias from another new ID → 409 `ALIAS_TAKEN`.
  - Same ID again → 409 `PLAYER_EXISTS`.
  - `GET /state` → the alias, score 0, a price that isn't stale.

  Smoke aliases stay reserved for good. That's accepted (D9).

**Tests first.**

- Player ID: accepts `crypto.randomUUID()` output. Rejects uppercase, UUID versions other than 4, `PRICE#LATEST`, `ALIAS#x`, `1`, the empty string.
- Alias: 3 and 20 characters accepted, 2 and 21 rejected. Letters, digits, `_` and `-` only. Rejects spaces and a Cyrillic `а`. The key is the lowercase form.
- Staleness: fresh at exactly 5 s old, stale just over.

**Not in this slice.** Guesses, the `open-guesses` index, on-demand polling (the poller runs every minute regardless), the chart, hidden-tab handling.

**Checks.** First deploy only: if the account isn't bootstrapped in `eu-north-1` yet, run `npx cdk bootstrap` once.

- [ ] `API_URL=<ApiUrl> npm run smoke` passes. The poller starts within a minute of the deploy, so run it after that.
- [ ] Open `SiteUrl` in a fresh browser. Pick an alias, see score 0 and the price moving about once a second.
- [ ] Reload: same alias and score, no alias form.

Until slice 3 is deployed, the poller runs every minute around the clock, about $10 a month pro rata (D10).

## Slice 2 — Guess and get scored

**Goal.** A player guesses up or down, and the poller resolves the guess at the first tick at least 60 s later whose price differs. After this slice, every requirement in the brief is met.

**Scope.**

- Table: GSI `open-guesses`, partition key `guessStatus`, sort key `guessedAt` (§5). Project `guessDirection` and `guessEntryPrice`, which the resolve step needs.
- `POST /guess` (§3 step 4, §6, D8).
  - Validate the direction (400).
  - Read `PRICE#LATEST`. Missing or more than 5 s old → 503 `PRICE_STALE`.
  - `UpdateItem` on the player: set `guessDirection`, `guessEntryPrice` (the latest price), `guessedAt` (server now), `guessStatus = OPEN`. Condition: `attribute_exists(pk) AND attribute_not_exists(guessStatus)`.
  - Use `ReturnValuesOnConditionCheckFailure: ALL_OLD` to tell failures apart: no old item → 404, otherwise 409 `GUESS_OPEN`.
  - 201 with the state.
- Poller resolve step, on every tick, after writing the price (§3 step 5, D4, D5).
  - Query `open-guesses` for `guessStatus = OPEN AND guessedAt <= now − 60 s`.
  - For each guess whose entry price differs numerically from the tick: one `UpdateItem` that adds ±1 to `score`, sets `lastResult`, and removes `guessDirection`, `guessEntryPrice`, `guessedAt` and `guessStatus`.
  - Condition: `guessStatus = OPEN AND guessedAt = <the queried value>` (§5). A failed condition means another run got there first. That's expected, so don't log it as an error.
  - `lastResult` is `{ direction, entryPrice, resolvedPrice, guessedAt, resolvedAt, delta }`, with `resolvedAt` = the tick's `observedAt`.
  - Log each resolution (D2).
- `GET /state` fills `openGuess` and `lastResult` (§6).
- Frontend.
  - Up and Down buttons. Disabled while a guess is open, while a request is in flight, and while `price` is null or stale. When stale, show "price feed unavailable".
  - Open-guess panel: direction, entry price, and a countdown to `guessedAt + 60 s` taken from the server's `guessedAt`. At zero it says "waiting for the price to move" (§3).
  - Last result: direction, entry → resolved price, +1 or −1.
  - On 409 or 503 from `POST /guess`, show a short message. The next poll shows the real state.
- Smoke test, guess part:
  - Bad direction → 400.
  - Guess → 201 with an `openGuess`.
  - Second guess → 409 `GUESS_OPEN`.
  - Poll `GET /state` until `openGuess` is `null`, giving up after 3 minutes. The score moved by exactly `lastResult.delta`, which is ±1.

  This part takes over a minute.

**Tests first.**

- Resolution: `UP` with a higher tick → +1, lower → −1. Mirrored for `DOWN`. Same price → no resolution, including `"86010.00"` against `"86010"`.
- Due cutoff: the ISO string for `now − 60 s`.
- Countdown (client): seconds left from `guessedAt` and now, never below zero.

**Not in this slice.** On-demand polling, the chart.

**Checks.**

- [ ] Smoke test passes, guess flow included.
- [ ] Guess in the browser, watch the countdown, see the score change and the last result.
- [ ] Guess, reload mid-countdown: the countdown carries on where it was.
- [ ] Two tabs: both show the same open guess and countdown. Neither can guess again.
- [ ] Guess, close the tab, come back after two minutes: the score has already changed (D5).

## Slice 3 — Poller only while in use (D10)

**Goal.** Nothing polls Coinbase or writes to DynamoDB while nobody is using the app and no guess is open.

**Scope.**

- `GET /state`, for an existing player (a 404 returns before this), using the price item it has already read:
  - **Visit.** If `lastVisitAt` is missing or more than 10 s old: `UpdateItem` `SET lastVisitAt = now`, conditional on it still being missing or more than 10 s old. Ignore a failed condition.
  - **Start.** If the price is missing or more than 3 s old, and `startRequestedAt` is missing or more than 70 s old: `UpdateItem` `SET startRequestedAt = now` with the same condition. If that write succeeds, invoke the poller with `InvocationType: 'Event'`.
  - Await the visit write before invoking. The new run's first step looks for a recent visit, and without it the run exits straight away.
  - Both happen before the response. The response doesn't wait for the poller itself.
- Poller. At the start of each run, read `PRICE#LATEST` and query `open-guesses` with `Limit: 1`. If there's no visit in the last 30 s and no open guess, log that and return. Otherwise run the usual ~70 s loop. Log when a run polls and when it exits idle.
- Infra: the poller's function name in the API Lambda's environment, and permission for the API Lambda to invoke it.
- Frontend: poll only while `document.visibilityState === 'visible'`. Stop on hide, resume on show (`visibilitychange`).

**Tests first.**

- Record a visit: `lastVisitAt` missing → yes. 10 s old or less → no. Older → yes.
- Start the poller: requires the price missing or more than 3 s old, and `startRequestedAt` missing or more than 70 s old.
- Poller run check: a visit within 30 s, or an open guess.

**Checks.**

- [ ] Smoke test passes.
- [ ] After a few idle minutes, open the site. It shows the old price's age with buttons disabled, then fresh prices within about 2 s.
- [ ] Close all tabs with no guess open. In the poller's CloudWatch logs, polling stops within 1–2 minutes, and later runs exit idle.
- [ ] Guess, then close the tab. Polling continues until the guess resolves and stops 1–2 minutes after. The score is updated on return.
- [ ] Switch to another browser tab for two minutes. Polling stops, as above.

## Slice 4 — Price chart (D11)

**Goal.** A live chart of the last 60 seconds of BTC/USD, full from the moment the page loads.

**Scope.**

- `GET /price/history` (§6, D11).
  - Requires a valid `X-Player-Id`, but no player. Doesn't touch DynamoDB.
  - Fetch `https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000` with a ~2 s timeout. Any failure → 502 `HISTORY_UNAVAILABLE`.
  - Reduce to the last trade in each whole second of the last 60 s, oldest first, as `{ value, time }` with `time` = the start of that second in ISO format. Coinbase returns trades newest first, with microsecond timestamps.
- Frontend chart.
  - A plain SVG line with no chart library. Y axis scaled to the window's minimum and maximum.
  - On load, and whenever the tab becomes visible: fetch the history and replace the chart's points. On 502, start empty.
  - Each poll adds `price.value` at `price.observedAt` only if it's newer than the chart's newest point.
  - Keep the 60 s before the newest point, anchored on the data rather than the device clock.
  - The chart also shows while the alias form is up.
- Smoke test: `GET /price/history` → points, oldest first, all within roughly the last minute.

**Tests first.**

- History reduction: keeps the latest trade in each second, drops trades older than 60 s, returns oldest first, skips seconds with no trade.
- Adding a polled point: ignored if not newer than the newest point. Otherwise appended, then everything more than 60 s before it is dropped.

**Checks.**

- [ ] Smoke test passes.
- [ ] On load, the chart already shows about a minute of prices.
- [ ] Switch away for two minutes and come back. The chart refills with no gap.

## Slice 5 — README and finish

**Goal.** A reviewer can understand, run and deploy the project from the README alone.

**Scope.**

- README, complete:
  - What the game is, with the live URL (`SiteUrl`).
  - The architecture in a paragraph, linking to [design.md](design.md).
  - Local setup, tests, deploy, smoke test.
- The trade-offs the design promises to state:
  - Up to a second can pass between the displayed price and the recorded entry price (D4).
  - The player ID is the only credential. Clearing storage or using a private window starts a new player at 0 (D6).
  - A cleared player's alias stays reserved (D9).
  - The chart can show a price the server never recorded (D11).
- A short "what we didn't do" (§10).
- Review the smoke test end to end. It runs with one command.
- No new features.

**Checks.**

- [ ] In a fresh clone in a temporary directory, following only the README: install, test, deploy and smoke test all work.
