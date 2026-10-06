# BTC Up/Down — Design and Decisions

Status: 6 October 2026. Written before any code and kept current since. Two decisions changed after the first build: a scheduled poller gave way to on-demand price fetches and one delayed SQS message per guess (D2, D5, D10), and a client-named entry price gave way to one the server picks (D4).

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
 Browser ── GET /state (every second) ──────┬──▶ API Lambda ──▶ Coinbase ticker
            POST /player, POST /guess ──────┘       │    │       (at most once a second per instance)
                                                    │    │
                                                    │    └──▶ DynamoDB ◀─────────────┐
                        POST /guess sends a message │                                │
                                     delayed 60 s   ▼                                │
                                                SQS queue ──▶ Resolver Lambda ───────┘
                                                    ▲               │
                                                    └── re-sent ────┤ after 2 s: price unchanged
                                                                    │ after 10 s: Coinbase down
                                                                    └──▶ Coinbase ticker

 Browser ── GET /price/history (on load, on tab return) ──▶ API Lambda ──▶ Coinbase trades
```

The page is a static React app on S3 and CloudFront (§8). One API Lambda serves all four routes. No scheduled jobs, no per-user processes, no WebSockets. The API fetches the price when a page asks for it (D2), each guess resolves when its own delayed message arrives (D5), and the chart's history comes from Coinbase's recent trades on request (D11). If a message is lost, `GET /state` resolves its guess once it's 2 minutes old (D5). Pages poll only while their tab is visible, so nothing runs while nobody is playing (D10).

## 3. Guess lifecycle

1. On first visit, the client generates a player ID and asks for an alias. `POST /player { alias }` creates the player at score 0 (D9).
2. The client polls `GET /state` every second while its tab is visible. On load and on tab return, it also calls `GET /price/history` to fill the chart (D11).
3. The player taps Up or Down: `POST /guess { direction }`.
4. The server takes the price it holds (D2, D4). It refuses with 503 `PRICE_STALE` if that price is missing or over 3 seconds old (D8), or 409 `GUESS_OPEN` if a guess is already open. Otherwise it sends a resolve message delayed 60 seconds, then saves `direction`, `entryPrice` and `guessedAt` (server time) with a conditional write (D5).
5. When the message arrives, the resolver fetches the price. If it differs from `entryPrice`, it applies ±1, clears the guess and stores the result, conditional on the guess still having the message's `guessedAt` (§5). Otherwise it re-sends the message: after 2 seconds if the price hasn't moved, 10 if Coinbase is down (D5).
6. The client's next poll shows the new score and no open guess.

The countdown is derived from the server's `guessedAt`, so it survives reloads and new tabs. After 60 seconds with no price change, the UI shows "Waiting for the price to move".

## 4. Decisions

### D1. Per-guess timer, not shared one-minute rounds

**Decision.** Each guess starts its own 60-second clock when the server accepts it.

**Why.** The brief says "60 seconds since the guess was made". A shared round would resolve a guess cast with one second left after one second. If it compared round-start to round-end prices, a player voting at second 59 would already have seen 59 seconds of movement. Fixing that needs a per-guess entry price anyway.

### D2. The API fetches the price on demand

**Decision.** No background poller. When a request needs the price, the API Lambda fetches the Coinbase ticker and reuses it for 1 second within that instance.

**Why.** Fetching follows use: with nobody visiting, nothing fetches (D10). Coinbase sees at most one call a second per warm API instance, however many tabs poll. At this traffic that's well under its 10 req/s limit (D3).

**Mechanics.**

- **Cache.** Module-scope variables hold the last price and the time of the last attempt. An instance handles one request at a time, so there's nothing to lock. Coinbase is tried at most once a second, counted from the last attempt, successful or not.
- **Failure.** The API returns the cached price with its age, which soon makes it stale (D8). A new instance with nothing cached returns `price: null`.
- **No overlapping polls.** The client skips a poll while the last one is in flight, so a slow Coinbase slows polling instead of stacking requests across instances.

**Accepted consequences.**

- Two instances can hold prices fetched a moment apart, so the headline price can briefly step back. The chart ignores older prices (D11). A guess takes the price of whichever instance handles it (D4).
- Coinbase calls scale with use: one a second per warm API instance, plus one per open guess per check (D5). That's a few a second at this traffic. At scale, a shared cache would be needed (§9).

**Rejected alternatives.**

- **A scheduled background poller.** The first design. EventBridge schedules at most once a minute, so each run looped for about 70 seconds. Staying idle when nobody played needed visit tracking, start requests from the API, and overlapping runs.
- **A shared latest-price item in DynamoDB.** A database read on every poll, and racing refreshes.
- **The browser fetching from Coinbase.** The server would have no price of its own for the entry (D4).
- **A WebSocket feed from a long-running container.** Too many moving parts for a half-day assignment. Polling once a second looks the same to the player.

### D3. Price source: Coinbase Exchange public ticker

**Decision.** `GET https://api.exchange.coinbase.com/products/BTC-USD/ticker`. No API key.

**Why.** A true BTC/USD pair, a documented limit of 10 req/s per IP (bursts to 15), and ~40 ms responses when probed.

Cloudflare caches the ticker for up to 1 second (`max-age=1`), so the price can be up to a second older than our `observedAt`. Cached responses don't seem to count against the rate limit.

**Alternatives probed.**

| API | Verdict |
|---|---|
| Bitstamp `ticker/btcusd` | Good fallback. BTC/USD, ~16 req/s allowed. |
| Kraken `public/Ticker` | Works, but public limit is roughly 1 req/s. Tight. |
| Binance `ticker/price` | Rejected. BTC/USDT not USD, and geo-blocks US IP ranges (HTTP 451). |
| CoinGecko free tier | Rejected. 5–15 req/min. |

### D4. The server picks both prices

**Decision.** The client sends only a direction. The entry price is whatever the API holds when the guess arrives (D2). The resolution price is the first price the resolver fetches, at least 60 seconds later, that differs from the entry (D5). The response returns the entry price as the current price, so the page shows it.

**Why.** "Resolved fairly" means the client can't influence either price: it can't send a value or pick a moment.

**Accepted consequence.** The entry can differ from the number on screen at the click by up to a second of movement, as likely for the player as against: the page polls once a second and may reach another instance (D2). The open-guess panel shows the entry price once the guess is accepted.

**Rejected alternatives.**

- **The client names a recent server price.** The second design: the API recorded each price it fetched, and a guess named one by its timestamp, honored for 3 seconds. The entry matched the screen exactly, but anyone calling the API directly could pick the best of the last three or four prices. It also needed a price item per fetch, a TTL and a write on every poll.
- **The client sends the price.** Anyone could send any price.
- **A signed price.** The same hindsight problem, plus a signing secret to manage.

### D5. Each guess resolves from its own delayed message

**Decision.** `POST /guess` sends an SQS message delayed 60 seconds. A resolver Lambda receives it, fetches the price, and resolves the guess if the price differs from the entry. Otherwise it re-sends the message: after 2 seconds if the price hasn't moved, 10 seconds if Coinbase can't be reached.

**Why.** Each guess resolves on time whether or not the player is online, which covers "close the browser and come back". Nothing runs between guesses, and no index or sweep is needed to find due guesses: the message carries everything the resolver needs.

**Mechanics.**

- **Message.** `{ playerId, direction, entryPrice, guessedAt }` on a standard queue, since FIFO queues can't delay individual messages. SQS never delivers a delayed message early. Batch size 1.
- **Check, send, then save.** `POST /guess` refuses before sending anything if there's no player, a guess is open, or the price is stale, so a refused guess costs nothing. It sends before saving, so every saved guess has a message. If the send fails, nothing is saved. If two tabs guess at once, the losing save's message later finds a different `guessedAt` and does nothing.
- **Re-send delays.** 2 seconds resolves a guess soon after the price moves. 10 seconds during a Coinbase outage avoids a call every 2 seconds per open guess, at the cost of resolving up to 10 seconds after recovery.
- **Resolve.** One conditional write adds ±1, stores the last result and clears the guess, if the player's `guessedAt` matches the message (§5). Duplicate deliveries and overlapping re-sends become no-ops.
- **Never dropped unresolved.** The resolver returns normally, letting SQS delete the message, only after resolving, finding the guess gone, or re-sending. Any other error throws, and SQS redelivers after the visibility timeout.

**Backup.** A lost message would lock the player out for good, so `GET /state` resolves a guess still open 2 minutes after it was made, at the price it's about to return unless that's stale (D8). It uses the same conditional write, so a late message and the backup can't both resolve it.

**Accepted consequence.** A lost message resolves on the player's next visit, at that moment's price, not on time.

**Rejected alternatives.**

- **A background poller sweeping open guesses.** The first design. It needed the poller running whenever any guess was open.
- **Resolving lazily on `GET /state` as the main mechanism.** A losing player could stay away until the price turned. As a backup it can't be gamed: it only acts on a lost message, which the player can't cause.
- **A dead-letter queue.** See §9.

### D6. Anonymous player identity: client-generated ID in local storage

**Decision.** On first visit the client generates a UUID, keeps it in local storage, and sends it as `X-Player-Id` on every request.

**Why.** The brief doesn't ask for authentication (§9), and this makes the lock hold across tabs and reloads. A server-set cookie was rejected because the frontend and API are on different origins, where cookies are fragile (SameSite rules, Safari's third-party blocking).

**Validation.** The server accepts only a canonical lowercase UUID v4, as `crypto.randomUUID()` produces, and returns 400 otherwise before touching DynamoDB. This rules out guessable IDs like `1`, and stops a client addressing an alias item with `X-Player-Id: ALIAS#…`.

**Accepted consequence.** Clearing storage or opening a private window starts a fresh player at 0. The ID works like a password: anyone holding it plays as that player. So the UI and the resolver's logs show the alias instead (D9).

### D7. Score is a plain signed integer

**Decision.** Score may go negative.

**Why.** The brief says "loses 1 point" with no floor.

### D8. A price is stale after 3 seconds

**Decision.** A price more than 3 seconds old is stale. `GET /state` marks it `stale`, the UI disables the guess buttons with a "price feed unavailable" notice, and `POST /guess` returns 503 `PRICE_STALE`. Open guesses wait while the resolver re-checks every 10 seconds (D5).

**Why.** Buttons shouldn't be enabled for a price the server won't accept. Three seconds is the 1-second cache lifetime plus the 2-second fetch timeout (D2), so a stale price means a fetch failed.

### D9. Players choose a unique alias, shown instead of the ID

**Decision.** Before their first guess, the player chooses an alias: 3 to 20 ASCII letters, digits, `_` or `-`, unique ignoring case, fixed once chosen. The UI shows it in place of the player ID, keeping the player's own casing.

**Why.** The player ID is the only credential (D6), so it should never appear on screen, where a screenshot could leak it. ASCII-only also rules out lookalike Unicode names.

**Mechanics.** DynamoDB can't enforce uniqueness on a non-key attribute, so each alias gets its own item, keyed `ALIAS#<lowercase alias>`. `POST /player` writes the player and alias items in one transaction, each conditional on not existing yet, so two players can't claim the same alias.

**Accepted consequence.** A player who clears storage can't reclaim their alias. Without authentication, the server can't tell it's the same person.

### D10. Nothing runs while nobody is playing

**Decision.** No scheduled jobs. The API fetches the price only when a page asks (D2), and an open guess's message is the only thing that runs unattended (D5). Hidden tabs stop polling, so a forgotten tab doesn't make the API fetch prices nobody sees.

**Why.** Idle, the only cost is Lambda polling the empty queue, which SQS bills as requests: within the free tier or a few cents a month.

**Accepted consequence.** The first request to a cold API instance waits for the cold start and a Coinbase call, about a second.

### D11. The price chart's history comes from Coinbase, through our API

**Decision.** The page charts the last 60 seconds of BTC/USD. On load and on tab return, the client calls `GET /price/history`, and the API turns recent Coinbase trades into one price per second. After that, each `GET /state` poll adds the latest price.

**Why.** We store no price history, and the API only fetches while someone is visiting (D10), so the first visitor after a quiet spell would find nothing recent. Coinbase keeps recent trades. Going through our API keeps players' IP addresses from Coinbase, keeps the price source a server detail (switching to Bitstamp, D3, wouldn't touch the client), and sends about 60 points instead of 1,000 trades.

**Mechanics.**

- **Upstream.** `GET https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000`. No key, no paging: when probed, 1,000 trades covered four to six minutes.
- **Same series as the live price.** The live price is Coinbase's last trade, sampled at most once a second (D2). The history keeps the last trade in each second.
- **Joining live prices.** The client adds a polled price only if it's newer than the chart's newest point, which drops duplicates and older prices from other instances (D2).
- **Window.** The 60 seconds up to the newest point, not the device clock, so a wrong clock can't empty the chart.
- **Display only.** The history plays no part in guessing. The entry and resolution prices are the server's own fetches (D4).

**Accepted consequences.**

- The history takes the last trade in each second, while the API samples partway through one, so the chart can show a price the server never fetched, even within an open guess. The guess panel shows the prices that count.
- If Coinbase can't be reached, or a busy minute has over 1,000 trades, the chart starts partly empty and fills from polls.
- Each page load and tab return is one more Coinbase call. At scale, the API would cache the result for a second.

**Rejected alternatives.**

- **The browser calls Coinbase directly.** Every player's browser would contact a third party and depend on Coinbase's API shape and cross-origin policy. Players on one network would share its per-IP limit.
- **Recording the prices the API fetches.** Nothing is recorded while idle (D10), so the chart would still start empty after a quiet spell.
- **Coinbase candles.** The smallest bucket is 60 seconds: one point for the whole minute.
- **No history.** The chart would be empty for a minute after every load and tab return.

## 5. Data model (DynamoDB)

One table, two item types, no secondary index. The resolver finds a guess by the player ID in its message.

**Player item**, keyed by `playerId`.

| Attribute | Notes |
|---|---|
| `alias` | As the player typed it (D9) |
| `score` | Signed integer |
| `guessDirection` | `UP` or `DOWN`, present only while a guess is open |
| `guessEntryPrice` | Decimal as string, present only while open |
| `guessedAt` | ISO timestamp, present only while open. Its presence is what makes a guess open. |
| `lastResult` | `{ direction, entryPrice, resolvedPrice, guessedAt, resolvedAt, delta }` of the latest resolved guess. The client keeps the last five in local storage, next to the player ID (D6). |

**Alias item**, keyed `ALIAS#<lowercase alias>`, exists only to make aliases unique (D9).

| Attribute | Notes |
|---|---|
| `playerId` | The player who holds the alias |

Every write that changes guess state is conditional, so duplicate messages, the `GET /state` backup and double-clicks can't double-apply. Opening a guess requires `attribute_not_exists(guessedAt)`. Resolving requires `guessedAt` to equal the message's. Checking only that some guess is open isn't enough: a late message for an earlier guess would resolve the player's newer guess with the old direction and entry price.

## 6. API

Every endpoint requires `X-Player-Id` and returns 400 `INVALID_PLAYER_ID` if it isn't a valid UUID v4 (D6). `GET /state` and `POST /guess` return 404 `PLAYER_NOT_FOUND` if the player doesn't exist yet, which the client treats as "ask for an alias". Errors are JSON: `{ "error": "<CODE>" }`.

**`POST /player`** with body `{ "alias": "Satoshi" }`

- 201 with the new state
- 409 `ALIAS_TAKEN` if another player holds the alias
- 409 `PLAYER_EXISTS` if this ID already has a player (e.g. a retried request)
- 400 `INVALID_ALIAS` if the alias breaks the rules in D9

**`GET /state`**

```json
{
  "price": { "value": "86024.74", "observedAt": "2026-10-02T14:48:33.120Z", "stale": false },
  "alias": "Satoshi",
  "score": 3,
  "openGuess": { "direction": "UP", "entryPrice": "86010.00", "guessedAt": "2026-10-02T14:47:50.312Z" },
  "lastResult": { "direction": "DOWN", "entryPrice": "...", "resolvedPrice": "...", "guessedAt": "...", "resolvedAt": "...", "delta": -1 }
}
```

`openGuess` and `lastResult` are `null` when absent. `price` is `null` when a new API instance couldn't reach Coinbase (D2). `stale` is true when the price is over 3 seconds old (D8).

**`POST /guess`** with body `{ "direction": "UP" | "DOWN" }`

- 201 with the new state. Its `price` is the entry price (D4).
- 409 `GUESS_OPEN` if a guess is already open
- 503 `PRICE_STALE` if the API has no price under 3 seconds old (D8)
- 400 `INVALID_DIRECTION` on a bad direction

**`GET /price/history`**

```json
{
  "points": [
    { "value": "86010.00000000", "time": "2026-10-02T14:47:34.000Z" },
    { "value": "86012.51000000", "time": "2026-10-02T14:47:35.000Z" }
  ]
}
```

The last 60 seconds, oldest first, one point per second with a trade (D11). Needs no existing player, so the chart shows while a new visitor picks an alias.

- 502 `HISTORY_UNAVAILABLE` if Coinbase can't be reached

## 7. Edge cases, by name

- **Price unchanged at 60 s.** Re-checked every 2 s. The UI says it's waiting for the price to move (D5).
- **Duplicate or late message.** The resolve write needs a matching `guessedAt`, so it's a no-op (§5).
- **Feed down.** The price shows its age, and guessing is disabled once it's over 3 s old. A guess sent anyway gets 503. Open guesses wait, re-checked every 10 s (D5, D8).
- **Player leaves with a guess open.** The message resolves it on time (D5).
- **Message lost.** `GET /state` resolves the guess on the next visit, once it's 2 minutes old (D5).
- **Two API instances, two prices.** The headline can step back up to a second, the chart ignores it, and the entry can differ from the headline (D2, D4).
- **Hidden tab.** Stops polling. On return, the chart reloads its history (D10, D11).
- **Coinbase trades unreachable.** `GET /price/history` returns 502, and the chart fills from polls (D11).
- **Two tabs.** Same player ID, same lock, same countdown.
- **Double-click.** The second request gets 409 before sending anything. If both arrive at once, the conditional write refuses one, and its message finds a different `guessedAt` (D5, §5).
- **Cleared storage / private window.** New player at 0 with a new alias. The old alias stays reserved (D6, D9).
- **Alias taken.** 409, and the UI asks for another. Of two simultaneous claims, the transaction lets one through (D9).
- **Malformed player ID.** 400 before any database access (D6).

## 8. Implementation choices

1. **Language and infrastructure-as-code.** TypeScript end to end on Node 22, with AWS CDK v2 in one stack: one language for Lambda, frontend, infra and tests. Alternatives were SAM, SST and Terraform.
2. **Frontend.** Vite + React, a handful of components, styled with Tailwind and shadcn/ui, with a Recharts chart.
3. **Frontend hosting.** S3 + CloudFront, private bucket with origin access control. CloudFront could also front the API under one origin if we later want cookies.
4. **Region.** `eu-north-1` (Stockholm). Coinbase works from the EU.
5. **Testing scope.** Vitest unit tests for the pure rules on server and client, and one smoke test against the deployed API, which covers the thin handlers. No DynamoDB Local.
6. **Price cadence.** One price a second, set by the API's cache (D2). Changing it means changing the client's poll rate, the chart's per-second history and the 3-second staleness threshold with it (D8, D11).

Conventions the code follows:

- **Timestamps** are always `new Date().toISOString()`, so stored and compared values share one format.
- **Prices** stay the exchange's decimal strings and are compared as numbers, never as strings: trades return `"86096.25000000"`, the ticker `"86096.25"`.
- **DynamoDB expressions** name every attribute through `ExpressionAttributeNames`, since reserved-word errors only show up after deploy.

## 9. What we didn't do

Authentication, a mobile layout and a leaderboard are left for when the game finds its fit with players.

### Authentication

**Why not.** The brief doesn't ask for it, and fairness doesn't depend on it: the server picks both prices (D4) and holds each player's lock. Auth would add continuity across devices, cleared storage and private windows. The cost: every reviewer would have to sign up and confirm an email before seeing the game, and the flows, verification and a smoke-test user would take much of the half-day budget.

**How it would fit.** A Cognito user pool, with API Gateway's JWT authorizer on the HTTP API. The API takes `playerId` from the token's `sub` claim instead of `X-Player-Id`. The data model, resolution, aliases and endpoints stay as they are. An anonymous player could keep their score and alias: on first sign-in the client sends its old ID once, and the server moves the player item and repoints the alias item in one transaction.

### Smaller omissions

- **Alias changes and moderation.** Aliases are fixed and not checked for offensive words. A script could reserve many. API Gateway throttling would slow that, but stopping it needs auth or a CAPTCHA.
- **Dead-letter queue.** A message that keeps failing for a reason other than Coinbase, such as a DynamoDB error, is redelivered every 30 seconds until SQS's 4-day retention ends. A dead-letter queue would set it aside after a few attempts. Without one, the `GET /state` backup still resolves the guess (D5), and errors show in the resolver's logs.
- **A shared price cache.** At scale, many API instances would each call Coinbase once a second, and every open guess at each check (D2, D5). A shared cache or a single fetcher would cut that to one call, and a concurrency cap on the resolver's event source would bound its share.
- **A mobile layout.** The page is one column at most 448 pixels wide, so it fits a phone but isn't designed for one. Once a player scrolls through their results, the score, price and guess buttons are off-screen. A mobile layout would pin them to the bottom.
- **A leaderboard.** Players see only their own score. A top-scores list could show aliases (D9), but ranking needs a secondary index sorted by score (§5), and a public list would make alias moderation matter more.
