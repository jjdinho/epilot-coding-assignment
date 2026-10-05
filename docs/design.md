# BTC Up/Down — Design and Decisions

Status: draft, 2 October 2026, updated 5 October 2026. Written before any code, to pin down what we agreed and why.

## 1. The brief, condensed

A web app where a player guesses whether BTC/USD will be higher or lower in one minute.

- Player always sees their current score and the latest BTC/USD price.
- Player guesses **up** or **down**. One open guess at a time.
- A guess resolves when **at least 60 seconds have passed since the guess was made** and **the price has changed** since then.
- Correct guess: +1. Incorrect: −1. New players start at 0.
- Guesses must be resolved fairly using a third-party price API.
- Scores persist in a backend store, AWS preferred. Deployed, public repo, README.
- Optional: close the browser, come back, keep playing with the same score.

The two clauses in bold drive most of the design.

## 2. Architecture at a glance

```
 Browser ──── GET /state (poll, every second) ───▶ API Lambda ────▶ DynamoDB
    │                                                                   ▲
    └──────── POST /player, POST /guess ─────────▶ API Lambda ──────────┤
                                                       │                │
                   starts the poller if price is stale │                │
                                                       ▼                │
 EventBridge (every minute) ──▶ Poller Lambda (loops ~70 s, 1 tick/s) ──┘
                                        │
                                        └──▶ Coinbase Exchange public ticker (BTC-USD)

 Browser ──── GET /price/history (on load, on tab return) ───▶ API Lambda
                                                                   │
                      Coinbase Exchange public trades (BTC-USD) ◀──┘
```

Three pieces: a static frontend, a small HTTP API, and one background poller. No per-user processes, no WebSockets, nothing that scales with player count except rows in a table. The poller only runs while someone is using the app (D10). For the price chart's history, the API fetches recent trades from Coinbase on request (D11).

## 3. Guess lifecycle

1. On first visit, the client generates a player ID and asks for an alias. It sends `POST /player { alias }` and the server creates the player at score 0 (see D9).
2. Client polls `GET /state` every second while its tab is visible and renders price, score, and the open guess if any. Each poll counts as a visit, which keeps the poller running (D10). On load, and when the tab becomes visible again, it also calls `GET /price/history` to fill the price chart with the last minute (D11).
3. Player taps Up or Down. Client sends `POST /guess { direction }`.
4. Server rejects with 409 if the player already has an open guess, or 503 if the latest tick is stale (see D8). Otherwise it records `direction`, `entryPrice` = the latest tick the server holds, and `guessedAt` = server time. Conditional write: fails if a guess appeared in between.
5. Poller, on every tick: fetch price, store it as the latest, then look up open guesses with `guessedAt ≤ now − 60 s`. For each one where `tick.price ≠ entryPrice`: apply ±1 to score, clear the guess, store the resolving price and time. Conditional on the guess still being open with the `guessedAt` the query returned (see §5).
6. Client's next poll shows the updated score and no open guess. The lock lifts.

The player sees a countdown derived from the server's `guessedAt`, so it survives reloads and new tabs. After 60 seconds with no price change, the UI shows "waiting for the price to move".

## 4. Decisions

### D1. Per-guess timer, not shared one-minute rounds

**Decision.** Each guess starts its own 60-second clock at the moment the server accepts it.

**Why.** The brief says "60 seconds since the guess was made". A shared round would resolve a guess cast with one second left after one second. It also has a fairness hole: if the round compares round-start to round-end price, a player voting at second 59 has already watched 59 seconds of movement. Fixing that means comparing against the price at guess time, which is per-guess resolution anyway.

### D2. One global price poller, roughly one tick per second

**Decision.** A single scheduled job polls the price API and writes the latest tick. Everyone reads from that.

**Why.** Price fetching does not need to scale with users. One poller at 1 req/s is a fraction of any exchange's public limit. Polling once a minute would be too coarse: the displayed price would go stale and resolution could lag nearly two minutes.

**Mechanics.** EventBridge's floor is one minute, so the poller Lambda is invoked each minute and loops internally: fetch, write, resolve, sleep one second, for about 70 seconds. Runs overlap by about 10 seconds on purpose. EventBridge can start a scheduled target several seconds late, so a run that stopped at or before the minute would leave a gap each minute with no ticks. The displayed price would go stale and due guesses would wait. During the overlap two runs tick side by side, about 2 req/s, still well under the limit (D3). Conditional writes make the duplicate resolve attempts harmless.

Runs only happen while the app is in use, and the API can start one early (D10). The poller logs resolutions, errors, and when polling starts or stops. It doesn't log individual ticks.

### D3. Price source: Coinbase Exchange public ticker

**Decision.** `GET https://api.exchange.coinbase.com/products/BTC-USD/ticker`. No API key.

**Why.** True BTC/USD pair. Documented limit of 10 req/s per IP (bursts to 15). Answered in ~40 ms when probed. Response includes the exchange's own trade timestamp, which we store alongside our observation time so the audit trail does not rest on our clock alone.

**Alternatives probed.**

| API | Verdict |
|---|---|
| Bitstamp `ticker/btcusd` | Good fallback. BTC/USD, ~16 req/s allowed. |
| Kraken `public/Ticker` | Works, but public limit is roughly 1 req/s. Tight. |
| Binance `ticker/price` | Rejected. BTC/USDT not USD, and geo-blocks US IP ranges (HTTP 451), which would bite a poller in a US region. |
| CoinGecko free tier | Rejected. 5–15 req/min. |

### D4. The server picks both prices; the client is never trusted

**Decision.** Entry price is the latest tick the server holds when the guess arrives. Resolution price is the first tick observed at or after `guessedAt + 60 s` whose price differs from entry. The client never sends a price.

**Why.** This is what "resolved fairly" means in practice. There may be up to a second between the number on the player's screen and the entry price recorded. That is accepted and will be stated in the README.

### D5. Resolution runs in the poller, not when the client reads

**Decision.** The poller resolves eligible guesses on every tick. The API never resolves guesses. `GET /state` reads game state, and its only writes are the visit marker and poller start in D10.

**Why.** Resolution then happens within a second or two of eligibility regardless of whether the player is online, because an open guess keeps the poller running (D10). That directly satisfies the optional "close the browser and return" requirement: the score is already updated when they come back. It also keeps the fairness story simple: the server decided at the first qualifying tick, with no client involvement.

**Rejected alternative.** Resolve lazily on `GET /state` against a stored tick history. Deterministic in principle, but it needs tick retention long enough to cover any absence, and a player returning after retention expired could not be resolved honestly. The poller approach needs no tick history. The entry and resolution price/time stored on the guess record are the audit trail.

### D6. Anonymous player identity: client-generated ID in local storage

**Decision.** On first visit the client generates a UUID, keeps it in local storage, and sends it as `X-Player-Id` on every request. The player is created at score 0 once they choose an alias (D9).

**Why.** The brief does not ask for authentication (see §10). This is enough to make the lock hold across tabs and reloads in the same browser. Chosen over a server-set cookie because the frontend and API will likely live on different origins, and cross-origin cookies are fragile (SameSite rules, Safari third-party blocking).

**Validation.** The server accepts `X-Player-Id` only as a canonical lowercase UUID v4, the format `crypto.randomUUID()` produces. Anything else gets a 400 before DynamoDB is touched. This stops clients choosing guessable IDs like `1`. It also guarantees a player key can never collide with the table's other keys, `PRICE#LATEST` and `ALIAS#…`. Without the check, a client sending `X-Player-Id: PRICE#LATEST` could write guess attributes onto the price item.

**Accepted consequence.** Clearing storage or opening an incognito window yields a fresh player at 0. The ID works like a password: anyone who holds it plays as that player. It can't be guessed, but it could leak, so the UI never displays it and shows the alias instead (D9). This will be stated in the README.

### D7. Score is a plain signed integer

**Decision.** Score may go negative. No floor at zero.

**Why.** The brief says "loses 1 point" with no floor. Taking it literally is the least surprising reading and the simplest.

### D8. Refuse guesses when the price feed is stale

**Decision.** If the latest tick is older than 5 seconds, `POST /guess` returns 503 and the UI disables the buttons with a "price feed unavailable" notice. Open guesses simply wait; they resolve when ticks resume.

**Why.** Accepting a guess against a stale entry price is unfair in both directions. A player watching the live price elsewhere could guess with several seconds of hindsight. Five seconds still leaves room for a slow upstream call at a one-second cadence. The cutoff matters because the poller stops when idle (D10). A visitor arriving just after it stops sees a price that is a few seconds old, and this rule caps how old a price they can guess against.

### D9. Players choose a unique alias, shown instead of the ID

**Decision.** Before their first guess, the player must choose an alias. The UI shows the alias and never the player ID. Aliases are unique across players, ignoring case, and fixed once chosen.

**Rules.** 3 to 20 characters: letters, digits, `_` and `-`. Uniqueness is checked on the lowercase form, so `Satoshi` and `satoshi` collide. The player's own casing is kept for display. Restricting to ASCII also rules out lookalike names built from Unicode characters, such as a Cyrillic `а` in place of a Latin `a`.

**Why.** The player ID is the player's only credential (D6), so it should never appear on screen, where a screenshot could leak it. The alias gives the player a name to show instead.

**Mechanics.** DynamoDB can't enforce uniqueness on a non-key attribute, so each alias gets its own item, keyed `ALIAS#<lowercase alias>`. `POST /player` writes the player item and the alias item in one transaction. Each write is conditional on its item not existing yet. If the alias is taken, the transaction fails and the API returns 409. Two players claiming the same alias at the same moment cannot both succeed.

**Accepted consequence.** A player who clears storage loses their player record and can't reclaim their alias. It stays reserved to the abandoned record. Without authentication, the server has no way to tell that the returning player is the same person.

### D10. The poller runs only while the app is in use

**Decision.** The poller runs while someone has visited in the last 30 seconds or any guess is open. Otherwise nothing polls Coinbase or writes to DynamoDB.

**Why.** Nothing should run when nobody is using the app. Polling around the clock costs about $2.20 a month in DynamoDB writes and queries, plus about $7.50 in Lambda time (192 MB on ARM) once the free allowance is used up, whether or not anyone plays. On demand, an idle month costs about 2 cents for the per-minute checks. An hour of play costs about 1 cent, plus under a cent per open tab. (Stockholm on-demand prices, October 2026.) The saving is a few dollars a month, but it's how we'd want a real service to behave, and the extra pieces are small.

**Why open guesses count.** If visitors alone kept the poller running, a player losing at second 50 could close the tab. The poller would stop, and the guess would wait until someone next visits and resolve at whatever the price is then. A near-certain loss becomes a coin flip. Keeping the poller running while any guess is open means every guess resolves at its first qualifying tick (D4), whether or not anyone is watching.

**Mechanics.**

- **Visits.** Each `GET /state` counts as a visit. The API writes `lastVisitAt` on the price item when the stored value is more than 10 seconds old, so all open tabs together cause at most one write every 10 seconds. The client stops polling while its tab is hidden, so a forgotten background tab doesn't keep the poller running.
- **Start.** If `GET /state` finds the price more than 3 seconds old, it treats the poller as stopped. The API records the visit, then invokes the poller Lambda asynchronously so the request doesn't wait. A conditional write on `startRequestedAt` allows one start per 70 seconds, the length of a run. That stops many tabs from each starting a poller. It also stops a Coinbase outage, which makes the price stale too, from piling up runs. The first fresh tick arrives about 1–2 seconds after the visit.
- **Stop.** The minute rule from D2 keeps firing. Each run first checks for a visit in the last 30 seconds or an open guess, using a one-item query on the `open-guesses` index. If it finds neither, it exits within milliseconds. Otherwise it loops for its usual ~70 seconds. So polling stops one to two minutes after the last visitor leaves and the last guess resolves.

**Accepted consequence.** The first visitor after an idle period briefly sees an old price. The UI shows its age and keeps the guess buttons disabled until the first fresh tick arrives (D8).

**Rejected alternative.** A poller that manages its own lifetime: a lease so only one runs at a time, and a restart of itself before Lambda's 15-minute limit. More code and more ways to fail. The minute rule also replaces a crashed run, which a self-managing poller would need its own safety net for.

### D11. The price chart's history comes from Coinbase, through our API

**Decision.** The page shows a live chart of the last 60 seconds of BTC/USD. On load, and whenever a hidden tab becomes visible again, the client calls `GET /price/history`. The API fetches recent trades from Coinbase and returns one price per second for the last minute. After that, each `GET /state` poll adds the server's latest price.

**Why.** We have no history of our own. The poller stops when nobody is using the app (D10), so the first visitor after a quiet spell would find nothing stored. Coinbase keeps recent trades, so the API can fetch them on request. Nothing new runs while the app is idle, and nothing new is stored.

**Why through our API.** The browser talks only to our own frontend and API, so Coinbase never sees players' IP addresses. The price source stays a server detail: switching to the Bitstamp fallback (D3) wouldn't touch the client. And the client receives about 60 points instead of 1,000 raw trades.

**Mechanics.**

- **Upstream request.** `GET https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000`. No API key. When probed on 5 October 2026, 1,000 trades covered four to six minutes, so one request covers the minute with room to spare. No paging.
- **Same series as the live price.** Our ticks are Coinbase's last trade price, sampled once a second (D3). The API reduces the trades to the last trade in each second, so the chart has one point per second on both sides of the join.
- **No storage.** The endpoint doesn't touch DynamoDB. The `GET /state` poll that starts at the same moment records the visit (D10).
- **Joining live prices.** The client adds a polled price only if its `observedAt` is newer than the chart's newest point. That drops duplicates, and the old price a visitor sees while the poller starts up (D10).
- **Window.** The client keeps the 60 seconds up to the chart's newest point. Anchoring on the data rather than the device clock means a wrong clock can't empty the chart.
- **Tab return.** Hidden tabs stop polling (D10), which leaves a gap in the chart. When the tab becomes visible, the client requests the history again, replaces the chart's points, and resumes polling.
- **Poll rate.** The client polls `GET /state` every second to match the tick rate. Polling every two seconds would make the live end of the chart half as dense as the history.

**Display only.** The history plays no part in resolution. The server still picks both prices from its own ticks (D4).

**Accepted consequences.**

- The history takes the last trade in each second, while the poller samples partway through a second. So the chart can show a price the server never recorded. After a reload or tab return, that can fall within an open guess. The guess panel shows the server's entry and resolution prices, which are the ones that count.
- If Coinbase can't be reached, or a very busy minute has more than 1,000 trades, the chart starts partly empty and fills from polls within a minute. Guessing is unaffected.
- Every page load and tab return makes one Coinbase call from AWS, alongside the poller's. Coinbase's public limit is 10 req/s per IP, plenty at this traffic. At scale, the API would cache the result for a second so all page loads in that second share one call.

**Rejected alternatives.**

- **Browser calls Coinbase directly.** Coinbase allows cross-origin requests, and it would save a Lambda call. But every player's browser would contact a third party, and the client would depend on Coinbase's API shape and cross-origin policy.
- **Store recent ticks ourselves.** One item per tick with a short expiry, and an endpoint returning the last 60. Nothing is stored while the app is idle (D10), so the first visitor after a quiet spell would still see an empty chart.
- **Coinbase candles.** The smallest bucket is 60 seconds, so the whole minute would be a single point.
- **No history.** The chart fills from polls alone, so it's empty for the first minute after every load and tab return.

## 5. Data model (DynamoDB)

One table, three item types.

**Player item**, keyed by `playerId`.

| Attribute | Notes |
|---|---|
| `alias` | As the player typed it, for display (D9) |
| `score` | Signed integer |
| `guessDirection` | `UP` or `DOWN`, present only while a guess is open |
| `guessEntryPrice` | Decimal as string, present only while open |
| `guessedAt` | ISO timestamp, present only while open |
| `guessStatus` | Constant `OPEN`, present only while open. Sparse GSI key. |
| `lastResult` | `{ direction, entryPrice, resolvedPrice, guessedAt, resolvedAt, delta }` from the most recent resolved guess, for display |

**Latest price item**, fixed key `PRICE#LATEST`.

| Attribute | Notes |
|---|---|
| `price` | Decimal as string, as returned by the exchange |
| `exchangeTime` | Trade timestamp from the Coinbase response |
| `observedAt` | Our server time when fetched |
| `lastVisitAt` | Written by the API at most every 10 s. Keeps the poller running (D10) |
| `startRequestedAt` | Written by the API when it starts the poller. Allows one start per 70 s (D10) |

The poller writes ticks with `UpdateItem`, setting only the price attributes, so it doesn't erase the two the API writes.

**Alias item**, keyed `ALIAS#<lowercase alias>`. Exists only to make aliases unique (D9).

| Attribute | Notes |
|---|---|
| `playerId` | The player who holds the alias |

**GSI `open-guesses`**: partition key `guessStatus`, sort key `guessedAt`. Sparse: only players with an open guess appear. The poller queries `guessStatus = OPEN AND guessedAt <= now − 60 s`. At the start of each run it also checks whether any guess is open at all (D10).

All writes that change guess state are conditional on the current state, so overlapping poller invocations or double-clicks cannot double-apply.

The resolve write checks `guessedAt` as well as `guessStatus`. The GSI is updated asynchronously. That doesn't matter for finding due guesses, which are at least 60 seconds old, but for a moment after a resolve the index can still list the old guess. If the player opens a new guess in that moment, a check on `guessStatus = OPEN` alone would pass, and the poller would resolve the new guess with the old guess's direction and entry price. Requiring `guessedAt` to equal the value the query returned makes that write fail instead.

## 6. API

Every endpoint requires the `X-Player-Id` header and returns 400 if it isn't a valid UUID v4 (D6). `GET /state` and `POST /guess` return 404 if no player exists for the ID yet. The client treats that as "ask for an alias".

**`POST /player`** with body `{ "alias": "Satoshi" }`

- 201 with the new state on success
- 409 `ALIAS_TAKEN` if another player holds the alias
- 409 `PLAYER_EXISTS` if this ID already has a player (e.g. a retried request)
- 400 if the alias breaks the rules in D9

**`GET /state`**

```json
{
  "price": { "value": "86024.74", "observedAt": "2026-10-02T14:48:33Z", "stale": false },
  "alias": "Satoshi",
  "score": 3,
  "openGuess": { "direction": "UP", "entryPrice": "86010.00", "guessedAt": "2026-10-02T14:47:50Z" },
  "lastResult": { "direction": "DOWN", "entryPrice": "...", "resolvedPrice": "...", "delta": -1, "resolvedAt": "..." }
}
```

`openGuess` and `lastResult` are `null` when absent.

**`POST /guess`** with body `{ "direction": "UP" | "DOWN" }`

- 201 with the new state on success
- 409 if a guess is already open
- 503 if the price feed is stale
- 400 on a bad direction

**`GET /price/history`**

```json
{
  "points": [
    { "value": "86010.00", "time": "2026-10-02T14:47:34Z" },
    { "value": "86012.51", "time": "2026-10-02T14:47:35Z" }
  ]
}
```

The last 60 seconds, oldest first, one point per second: the last Coinbase trade in that second. Seconds with no trade are skipped (D11). Doesn't need an existing player, so the chart can show while a new visitor picks an alias.

- 502 if Coinbase can't be reached. The client starts the chart empty.

## 7. Edge cases, by name

- **Price unchanged at 60 s.** Guess stays open until a differing tick. UI says so.
- **Overlapping poller runs.** By design, for about 10 seconds each minute (D2), and for up to 70 seconds after the API starts one (D10). Conditional writes; at worst one run does a no-op.
- **Stale index entry.** The resolve write requires a matching `guessedAt`, so a lagging index can't resolve a player's newer guess (§5).
- **Feed down.** Price shown with its age, guess buttons disabled after 5 s of staleness, open guesses wait. The API starts at most one extra run per 70 s while the price is stale (D10).
- **First visit after idle.** The poller starts within 1–2 s. Until its first tick, the price shows its age and guessing is disabled (D8, D10).
- **Player leaves with a guess open.** The open guess keeps the poller running, so it resolves on time (D10).
- **Forgotten background tab.** Hidden tabs stop polling, so they don't keep the poller running (D10).
- **Tab becomes visible again.** The client requests the chart's history again, filling the gap left while polling was paused (D11).
- **Coinbase trades unreachable.** `GET /price/history` returns 502. The chart starts empty and fills from polls. Guessing is unaffected (D11).
- **Two tabs.** Same `X-Player-Id`, same lock, both show the same countdown.
- **Double-click.** Second request hits the conditional write and gets 409.
- **Cleared storage / incognito.** New player at 0, who must choose a new alias. The old alias stays reserved. Accepted, documented.
- **Alias taken.** 409, and the UI asks for another. Two players claiming the same alias at once: the transaction lets exactly one through.
- **Malformed player ID.** 400 before any database access.

## 8. Still open, to decide next

1. **Language and infrastructure-as-code.** Recommendation: TypeScript end to end, AWS CDK. One language for Lambda, frontend, infra, and tests. Alternatives: SAM, SST, Terraform.
2. **Frontend.** Recommendation: Vite + React, kept to a handful of components. Vanilla is viable given the UI is one screen.
3. **Frontend hosting.** S3 + CloudFront, or Amplify Hosting. Either is fine; CloudFront can also front the API under one origin if we later want cookies.
4. **Region.** Recommendation: `eu-north-1` (Stockholm). Coinbase works from the EU.
5. **Testing scope.** Recommendation: unit tests for the pure domain logic (resolution rule, staleness, state transitions) and one end-to-end smoke test against the deployed API. No DynamoDB Local.
6. **Tick cadence.** One per second is the plan. Two per second is within limits if the UI feels sluggish; one per two seconds if we want more headroom. Trivial to change, but the client's poll rate and the chart's per-second history points should change with it (D11).

## 9. Rejected along the way

- **Shared one-minute rounds.** Breaks the "since the guess was made" clause and creates a late-vote exploit. See D1.
- **Lazy resolution against tick history.** Retention hole for long absences, resolution tied to client presence. See D5.
- **WebSocket price feed in a long-running container.** More moving parts than a half-day assignment warrants; polling at 1 Hz is indistinguishable to the player.
- **Binance, CoinGecko.** See D3.
- **Always-on poller.** Simplest, but runs and bills around the clock with nobody playing. See D10.
- **Self-managing poller.** A lease plus self-restart before Lambda's 15-minute limit. More failure modes than the minute rule. See D10.
- **Storing tick history for the chart.** The poller is idle when nobody plays, so there would be nothing to show the first visitor. See D11.
- **Browser fetching chart history from Coinbase directly.** Exposes players to a third party and ties the client to Coinbase's API. See D11.

## 10. What we didn't do

### Authentication

**Why not.** The brief doesn't ask for it, and the game's fairness doesn't depend on it. The server picks both prices (D4) and holds the lock for each player, so a signed-in player couldn't do anything an anonymous one can't. What auth would add is continuity: the same player on another device, after clearing storage, or in a private window, with their alias intact. The cost is that every reviewer would have to sign up and confirm an email before seeing the game. Building the sign-up and sign-in flows, email verification, and a test user for the smoke test would also take a large share of the half-day budget.

**How it would fit.** Add a Cognito user pool and attach API Gateway's built-in JWT authorizer to the HTTP API. The API then takes `playerId` from the token's `sub` claim instead of the `X-Player-Id` header. The data model, resolution logic, aliases and endpoints stay as they are. Existing anonymous players could keep their score and alias: on first sign-in the client sends its old ID once, and the server moves the player item to the new key and repoints the alias item, all in one transaction.

### Per-guess delayed message (SQS)

**What it is.** `POST /guess` would send an SQS message with a 60-second delay, and a Lambda would resolve the guess when the message arrives. No sweep and no open-guesses index.

**Why not now.** The poller has to run anyway to keep the displayed price live, and it already checks for due guesses on every tick. A queue would be a second mechanism for the same job, with its own retry and failure handling. It also fits the brief's rule awkwardly. If the price hasn't moved at 60 seconds, the handler has to re-send the message and check again, which is a polling loop per guess.

**When it would be worth it.** At a volume where one poller can't resolve every due guess within a tick, or the open-guesses index's single partition runs hot. Delayed messages spread resolution across parallel Lambda invocations, and SQS adds retries and a dead-letter queue for resolutions that fail.

### Smaller omissions

- **Alias changes and moderation.** Aliases are fixed once chosen and not checked for offensive words. Without sign-up, a script could also reserve many aliases. API Gateway throttling would slow that down, but stopping it outright needs auth or a CAPTCHA.
- **Sharding the open-guesses index.** Its partition key is a constant, which becomes a single hot partition at real scale. The standard fix is to spread the key across a few values and query them in parallel. Not needed at this traffic.
- **Backup poller.** Nothing else fetches the price or resolves guesses if the poller stops. A crashed run is usually replaced within seconds, because `GET /state` starts a poller when the price goes stale (D10). At worst the next minute's run replaces it. Meanwhile the guess buttons disable after 5 seconds (D8) and open guesses wait. A poller that keeps failing stops the game until it's fixed. If we want a backup, `GET /state` can be it: when the latest tick is more than a few seconds old, the request fetches the price and runs the poller's resolve step itself. Conditional writes already make that safe alongside the poller. Only one request per second should do it, so a busy page doesn't call Coinbase once per open browser.
