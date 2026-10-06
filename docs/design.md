# BTC Up/Down — Design and Decisions

Status: draft, 2 October 2026, updated 6 October 2026. Written before any code, to pin down what we agreed and why. On 6 October the background poller of slices 1–3 was replaced: the API now fetches the price on demand, and each guess resolves from its own delayed SQS message (D2, D4, D5, D8, D10). The build is specified in [spec-sqs-resolution.md](spec-sqs-resolution.md).

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

Four pieces: a static frontend, a small HTTP API, a queue, and a resolver Lambda. No scheduled jobs, no per-user processes, no WebSockets. The API fetches the price when a page asks for it (D2). Each guess resolves when its own delayed message arrives (D5). Nothing runs while nobody is playing (D10). For the price chart's history, the API fetches recent trades from Coinbase on request (D11).

## 3. Guess lifecycle

1. On first visit, the client generates a player ID and asks for an alias. It sends `POST /player { alias }` and the server creates the player at score 0 (see D9).
2. Client polls `GET /state` every second while its tab is visible and renders price, score, and the open guess if any. The API fetches the price from Coinbase at most once a second per Lambda instance and records every price it fetches (D2). On load, and when the tab becomes visible again, the client also calls `GET /price/history` to fill the price chart with the last minute (D11).
3. Player taps Up or Down. Client sends `POST /guess { direction, priceObservedAt }`, naming the price on screen by its `observedAt` time.
4. Server rejects with 409 `PRICE_EXPIRED` unless it recorded that price in the last 3 seconds (D4, D8), and with 409 `GUESS_OPEN` if the player already has a guess open. Both checks come before anything is sent. Otherwise it sends a resolve message with a 60-second delay, then records `direction`, `entryPrice` = that price, and `guessedAt` = server time. Conditional write: fails with 409 if a guess was opened meanwhile (D5).
5. When the message arrives, the resolver fetches the price. If it differs from `entryPrice`: apply ±1 to score, clear the guess, store the resolving price and time. Conditional on the guess still being open with the message's `guessedAt` (see §5). If the price hasn't changed, it sends the message again with a 2-second delay. If Coinbase can't be reached, with a 10-second delay (D5).
6. Client's next poll shows the updated score and no open guess. The lock lifts.

The player sees a countdown derived from the server's `guessedAt`, so it survives reloads and new tabs. After 60 seconds with no price change, the UI shows "waiting for the price to move". If a guess is somehow still open 2 minutes after it was made, `GET /state` resolves it (D5).

## 4. Decisions

### D1. Per-guess timer, not shared one-minute rounds

**Decision.** Each guess starts its own 60-second clock at the moment the server accepts it.

**Why.** The brief says "60 seconds since the guess was made". A shared round would resolve a guess cast with one second left after one second. It also has a fairness hole: if the round compares round-start to round-end price, a player voting at second 59 has already watched 59 seconds of movement. Fixing that means comparing against the price at guess time, which is per-guess resolution anyway.

### D2. The API fetches the price on demand

**Decision.** No background poller. When a request needs the price, the API Lambda fetches the Coinbase ticker and reuses the result for 1 second within the same Lambda instance. Every price it fetches is recorded, so a guess can name it (D4).

**Why.** Price fetching follows use. With nobody visiting, nothing fetches (D10). Coinbase sees at most one call per second per warm API instance, however many tabs poll. At this traffic that's a handful of instances, well under the 10 req/s limit (D3).

**Mechanics.**

- **Cache.** A variable in the API Lambda's module scope holds the last fetched price and the time of the last attempt. A Lambda instance handles one request at a time, so there's nothing to lock. Coinbase is tried at most once a second per instance, counted from the last attempt whether or not it succeeded. Between attempts, requests get the cached price.
- **Record.** After each fetch, the API writes the price as its own item, keyed by its `observedAt` time (§5), and waits for the write before responding. A guess can then name that price straight away.
- **Failure.** If Coinbase can't be reached, the API returns the cached price with its age, which soon makes it stale (D8), and doesn't try again for a second. A new instance with nothing cached returns `price: null`.
- **Polls don't overlap.** The client skips a poll while the previous one is in flight. A slow Coinbase then slows each tab's polling to match, instead of stacking requests that spread across API instances, each fetching for itself.

**Accepted consequences.** Two API instances can hold prices fetched at slightly different moments. One poll can then return a price up to a second older than the poll before. The chart ignores older prices (D11), but the headline price can briefly step back. A guess against either price is honored (D4).

Coinbase calls also scale with use rather than being fixed at one per second: one per second per warm API instance, plus one per open guess per check (D5). At this traffic that's a few calls a second at most, about what the poller made. At scale a shared price cache would be needed (§10). This will be stated in the README.

**Rejected alternatives.**

- **A background poller on a schedule.** This was the first design, built in slices 1–3. EventBridge can't schedule more often than once a minute, so each run looped for about 70 seconds, fetching once a second. Keeping it idle when nobody played needed visit tracking, start requests from the API, and overlapping runs. Fetching on request needs none of that.
- **A shared latest-price item in DynamoDB.** Every instance would show the same price. But every poll would add a database read, and concurrent refreshes would race.
- **The browser fetching from Coinbase.** The server couldn't tell which price the player saw (D4). See also D11.

### D3. Price source: Coinbase Exchange public ticker

**Decision.** `GET https://api.exchange.coinbase.com/products/BTC-USD/ticker`. No API key.

**Why.** True BTC/USD pair. Documented limit of 10 req/s per IP (bursts to 15). Answered in ~40 ms when probed. Response includes the exchange's own trade timestamp, which we store alongside our observation time so the audit trail does not rest on our clock alone.

Coinbase serves the ticker through Cloudflare, which caches it for up to 1 second (`max-age=1`, checked 6 October 2026). So the price can be up to a second older than our `observedAt`, whatever we do. Cached responses don't seem to count against the rate limit: 25 simultaneous cached requests from one IP all succeeded, while 7 of 25 uncached ones were refused with 429.

**Alternatives probed.**

| API | Verdict |
|---|---|
| Bitstamp `ticker/btcusd` | Good fallback. BTC/USD, ~16 req/s allowed. |
| Kraken `public/Ticker` | Works, but public limit is roughly 1 req/s. Tight. |
| Binance `ticker/price` | Rejected. BTC/USDT not USD, and geo-blocks US IP ranges (HTTP 451), which would bite a Lambda in a US region. |
| CoinGecko free tier | Rejected. 5–15 req/min. |

### D4. The entry price is the price the player saw; the server picks the resolution price

**Decision.** A guess names the price on the player's screen by its `observedAt` time. The server accepts it only if it recorded that price in the last 3 seconds (D2), and uses it as the entry price. The resolution price is the first price the resolver fetches, at least 60 seconds after the guess, that differs from the entry price (D5). The client never sends a price value.

**Why.** "Resolved fairly" needs two things. First, the client can't choose a price: it can only name one the server fetched from Coinbase and recorded. Second, the price that counts is the one the player saw: the entry price matches the screen exactly. In the first design the server took the latest price it held when the guess arrived, which could differ from the screen by up to a second.

**Why 3 seconds.** A price can be up to 1 second old when served (D2). The client shows it until the next poll, about a second later. Network time comes on top.

**Validation.** `priceObservedAt` must be an ISO timestamp in exactly the format the server writes, `new Date().toISOString()`. Anything else gets a 400 before DynamoDB is touched. As with the player ID (D6), a client then can't use it to read any item but a price.

**Accepted consequence.** Honoring a price from the past gives the player up to 3 seconds of hindsight. A player watching a faster feed elsewhere could see a move, then guess against the older price on our screen. A shorter window means less hindsight, but more honest guesses refused as expired. This will be stated in the README.

**Rejected alternatives.**

- **The latest price when the guess arrives.** No hindsight beyond Coinbase's own caching (D3), but the entry price could differ from the screen. That was the first design.
- **The client sends the price value.** Anyone could send any price.
- **A signed price.** The server signs each price it returns, and the guess sends it back. No storage needed, but a signing secret to create, store and rotate. A recorded price is simpler, and the records double as an audit trail of what players were shown.

### D5. Each guess resolves from its own delayed message

**Decision.** `POST /guess` sends an SQS message with a 60-second delay. A resolver Lambda receives it, fetches the price, and resolves the guess if the price differs from the entry price. If the price hasn't changed, it sends the message again with a 2-second delay. If Coinbase can't be reached, with a 10-second delay.

**Why.** Each guess resolves on time whether or not the player is online. That satisfies the optional "close the browser and return" requirement: the score is already updated when they come back. Nothing runs between guesses, and no sweep or index is needed to find due guesses. The message carries everything the resolver needs.

**Mechanics.**

- **Message.** `{ playerId, direction, entryPrice, guessedAt }`. A standard queue: FIFO queues can't delay individual messages. SQS never delivers a delayed message early, so a guess can't resolve before 60 seconds.
- **Check, send, then save.** `POST /guess` reads the player first and refuses, before sending anything, if there's no player or a guess is already open. A refused guess then costs no message, no resolver run and no Coinbase call. Otherwise it sends the message, then saves the guess. If the send fails, nothing is saved and the player can try again. The save can still fail when two tabs guess at the same moment. The loser's message then arrives for a guess with a different `guessedAt`: the resolver fetches a price, and once that differs from the message's entry price, the conditional write fails and the message is done.
- **One message per invocation.** Batch size 1. The resolver fetches the price, then resolves the guess, re-sends the message, or stops.
- **Two re-send delays.** 2 seconds when the price hasn't moved, so a guess resolves soon after it does. 10 seconds when Coinbase can't be reached: during an outage every open guess is retrying, and a 2-second cadence would mean a Coinbase call every 2 seconds per open guess. The cost is that a guess can resolve up to 10 seconds after Coinbase recovers.
- **Resolve.** One conditional write, as in the first design: add ±1 to the score, store the last result, clear the guess. The condition is that the player has an open guess with the message's `guessedAt` (§5). A failed condition means the guess was already resolved or never saved, and the message is done.
- **Never dropped unresolved.** The resolver returns normally, which lets SQS delete the message, only after resolving the guess, finding it gone, or re-sending the message. Any other error throws, and SQS delivers the message again after its visibility timeout.
- **Duplicates.** SQS can deliver a message twice, and re-sends can overlap. The conditional write turns every extra attempt into a no-op.
- **Logs.** The resolver logs each resolution with the player's alias, not their ID (D6), and errors. It doesn't log re-sends.

**Backup.** If a guess is still open 2 minutes after it was made, `GET /state` resolves it with the price it's about to return, unless that price is stale (D8). It uses the same conditional write. With the mechanics above, a message shouldn't be lost. But a lost message would otherwise lock the player out for good, and the backup is a few lines. Concurrent with a late message, the conditional write lets exactly one resolve.

**Accepted consequence.** If a message were lost, the guess would resolve the next time the player visits, at that moment's price, not on time.

**Rejected alternatives.**

- **A background poller sweeping open guesses.** The first design, built in slices 2–3: the poller from D2 queried an index of open guesses every second and resolved the due ones. It needed the poller running whenever any guess was open, wherever the player was. Delayed messages do the same job with nothing running in between.
- **Resolving lazily on `GET /state`, as the main mechanism.** A losing player could stay away until the price turned in their favor, then come back to resolve. As a backup it can't be gamed that way: it only acts when a message is lost, and the player can't cause that.
- **A dead-letter queue.** See §10.

### D6. Anonymous player identity: client-generated ID in local storage

**Decision.** On first visit the client generates a UUID, keeps it in local storage, and sends it as `X-Player-Id` on every request. The player is created at score 0 once they choose an alias (D9).

**Why.** The brief does not ask for authentication (see §10). This is enough to make the lock hold across tabs and reloads in the same browser. Chosen over a server-set cookie because the frontend and API will likely live on different origins, and cross-origin cookies are fragile (SameSite rules, Safari third-party blocking).

**Validation.** The server accepts `X-Player-Id` only as a canonical lowercase UUID v4, the format `crypto.randomUUID()` produces. Anything else gets a 400 before DynamoDB is touched. This stops clients choosing guessable IDs like `1`. It also guarantees a player key can never collide with the table's other keys, `PRICE#…` and `ALIAS#…`. Without the check, a client sending `X-Player-Id: PRICE#…` could write guess attributes onto a price item.

**Accepted consequence.** Clearing storage or opening an incognito window yields a fresh player at 0. The ID works like a password: anyone who holds it plays as that player. It can't be guessed, but it could leak, so the UI never displays it and shows the alias instead (D9). This will be stated in the README.

### D7. Score is a plain signed integer

**Decision.** Score may go negative. No floor at zero.

**Why.** The brief says "loses 1 point" with no floor. Taking it literally is the least surprising reading and the simplest.

### D8. A price is stale after 3 seconds

**Decision.** A price more than 3 seconds old is stale. `GET /state` marks it `stale`, and the UI disables the guess buttons with a "price feed unavailable" notice. `POST /guess` refuses it with 409 `PRICE_EXPIRED` (D4). Open guesses simply wait: the resolver keeps re-checking every 10 seconds until Coinbase answers (D5).

**Why.** It's the same 3 seconds as D4. Buttons shouldn't be enabled for a price the server won't accept. While Coinbase answers, every price the API serves is under a second old (D2). So a stale price means the API couldn't reach Coinbase.

### D9. Players choose a unique alias, shown instead of the ID

**Decision.** Before their first guess, the player must choose an alias. The UI shows the alias and never the player ID. Aliases are unique across players, ignoring case, and fixed once chosen.

**Rules.** 3 to 20 characters: letters, digits, `_` and `-`. Uniqueness is checked on the lowercase form, so `Satoshi` and `satoshi` collide. The player's own casing is kept for display. Restricting to ASCII also rules out lookalike names built from Unicode characters, such as a Cyrillic `а` in place of a Latin `a`.

**Why.** The player ID is the player's only credential (D6), so it should never appear on screen, where a screenshot could leak it. The alias gives the player a name to show instead.

**Mechanics.** DynamoDB can't enforce uniqueness on a non-key attribute, so each alias gets its own item, keyed `ALIAS#<lowercase alias>`. `POST /player` writes the player item and the alias item in one transaction. Each write is conditional on its item not existing yet. If the alias is taken, the transaction fails and the API returns 409. Two players claiming the same alias at the same moment cannot both succeed.

**Accepted consequence.** A player who clears storage loses their player record and can't reclaim their alias. It stays reserved to the abandoned record. Without authentication, the server has no way to tell that the returning player is the same person.

### D10. Nothing runs while nobody is playing

**Decision.** No scheduled jobs. The API fetches the price only when a page asks for it (D2). An open guess's message is the only thing that runs while nobody is watching (D5). A hidden tab stops polling.

**Why.** Nothing should run when nobody is using the app. Idle, the only cost is Lambda polling the queue for messages. SQS bills those polls as requests, but at this size that's within its free allowance or a few cents a month. The first design needed visit tracking, poller starts and an idle check to get close to this. Here it follows from fetching on request and resolving from messages.

**Why hidden tabs stop.** A forgotten background tab would otherwise make the API fetch a price every second that nobody sees. When the tab becomes visible again, polling resumes and the chart reloads its history (D11).

**Accepted consequence.** The first request to a cold API instance waits for a Coinbase call, about a second including the Lambda cold start.

### D11. The price chart's history comes from Coinbase, through our API

**Decision.** The page shows a live chart of the last 60 seconds of BTC/USD. On load, and whenever a hidden tab becomes visible again, the client calls `GET /price/history`. The API fetches recent trades from Coinbase and returns one price per second for the last minute. After that, each `GET /state` poll adds the server's latest price.

**Why.** We have no usable history of our own. The API records prices only while someone is visiting (D2, D10), so the first visitor after a quiet spell would find nothing recent stored. Coinbase keeps recent trades, so the API can fetch them on request. Nothing new runs while the app is idle, and nothing new is stored.

**Why through our API.** The browser talks only to our own frontend and API, so Coinbase never sees players' IP addresses. The price source stays a server detail: switching to the Bitstamp fallback (D3) wouldn't touch the client. And the client receives about 60 points instead of 1,000 raw trades.

**Mechanics.**

- **Upstream request.** `GET https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000`. No API key. When probed on 5 October 2026, 1,000 trades covered four to six minutes, so one request covers the minute with room to spare. No paging.
- **Same series as the live price.** Our live prices are Coinbase's last trade price, sampled at most once a second (D2, D3). The API reduces the trades to the last trade in each second, so the chart has one point per second on both sides of the join.
- **No storage.** The endpoint doesn't touch DynamoDB.
- **Joining live prices.** The client adds a polled price only if its `observedAt` is newer than the chart's newest point. That drops duplicates, and an older price from another API instance (D2).
- **Window.** The client keeps the 60 seconds up to the chart's newest point. Anchoring on the data rather than the device clock means a wrong clock can't empty the chart.
- **Tab return.** Hidden tabs stop polling (D10), which leaves a gap in the chart. When the tab becomes visible, the client requests the history again, replaces the chart's points, and resumes polling.
- **Poll rate.** The client polls `GET /state` every second to match the API's price cache (D2). Polling every two seconds would make the live end of the chart half as dense as the history.

**Display only.** The history plays no part in guessing or resolution. A guess can only name a price the API recorded, and the resolver fetches its own (D4).

**Accepted consequences.**

- The history takes the last trade in each second, while the API samples partway through a second. So the chart can show a price the server never recorded. After a reload or tab return, that can fall within an open guess. The guess panel shows the server's entry and resolution prices, which are the ones that count.
- If Coinbase can't be reached, or a very busy minute has more than 1,000 trades, the chart starts partly empty and fills from polls within a minute. Guessing is unaffected.
- Every page load and tab return makes one Coinbase call from AWS, alongside the price fetches (D2). Coinbase's public limit is 10 req/s per IP, plenty at this traffic. At scale, the API would cache the result for a second so all page loads in that second share one call.

**Rejected alternatives.**

- **Browser calls Coinbase directly.** Coinbase allows cross-origin requests, and it would save a Lambda call. But every player's browser would contact a third party, and the client would depend on Coinbase's API shape and cross-origin policy. Coinbase's limit is per IP, so players sharing one network would also share it. For the live price, the server couldn't tell which price a player saw (D4).
- **Serve the recorded prices.** The API already records every price it fetches (D2), so an endpoint could return the last 60 seconds of them. But nothing is recorded while the app is idle (D10), so the first visitor after a quiet spell would still see an empty chart.
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
| `guessedAt` | ISO timestamp, present only while open. Its presence is what makes a guess open. |
| `lastResult` | `{ direction, entryPrice, resolvedPrice, guessedAt, resolvedAt, delta }` from the most recent resolved guess, for display |

**Price item**, keyed `PRICE#<observedAt>`. One per price the API fetches (D2), so a guess can name it (D4).

| Attribute | Notes |
|---|---|
| `price` | Decimal as string, as returned by the exchange |
| `exchangeTime` | Trade timestamp from the Coinbase response |
| `observedAt` | Our server time when fetched, the same as in the key |
| `expiresAt` | `observedAt` plus 1 hour, in epoch seconds. The table's TTL attribute. |

DynamoDB deletes expired items in the background, sometimes days late, so the 3-second window is enforced by checking `observedAt`, never by the item being gone. The hour keeps recent prices around for debugging. The guess itself stores its entry and resolution prices, so nothing depends on the price items after the guess is made.

**Alias item**, keyed `ALIAS#<lowercase alias>`. Exists only to make aliases unique (D9).

| Attribute | Notes |
|---|---|
| `playerId` | The player who holds the alias |

All writes that change guess state are conditional on the current state, so duplicate messages, the `GET /state` backup and double-clicks cannot double-apply.

Opening a guess requires `attribute_not_exists(guessedAt)`. Resolving one requires `guessedAt` to equal the value in the message. Checking only that some guess is open isn't enough. A late or duplicate message for an earlier guess would then resolve the player's newer guess with the old guess's direction and entry price. Requiring the same `guessedAt` makes that write fail instead.

The table has no secondary index. The resolver finds a guess by the player ID in its message.

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
  "price": { "value": "86024.74", "observedAt": "2026-10-02T14:48:33.120Z", "stale": false },
  "alias": "Satoshi",
  "score": 3,
  "openGuess": { "direction": "UP", "entryPrice": "86010.00", "guessedAt": "2026-10-02T14:47:50Z" },
  "lastResult": { "direction": "DOWN", "entryPrice": "...", "resolvedPrice": "...", "delta": -1, "resolvedAt": "..." }
}
```

`openGuess` and `lastResult` are `null` when absent. `price` is `null` when the API has no price at all: Coinbase couldn't be reached by a new API instance (D2). `stale` is true when the price is more than 3 seconds old (D8).

**`POST /guess`** with body `{ "direction": "UP" | "DOWN", "priceObservedAt": "2026-10-02T14:48:33.120Z" }`

`priceObservedAt` is the `price.observedAt` of the price on screen, sent back exactly as received (D4).

- 201 with the new state on success
- 409 `GUESS_OPEN` if a guess is already open
- 409 `PRICE_EXPIRED` if the server didn't record that price, or recorded it more than 3 seconds ago
- 400 `INVALID_DIRECTION` on a bad direction
- 400 `INVALID_PRICE_OBSERVED_AT` if `priceObservedAt` isn't a timestamp in the server's format

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

- **Price unchanged at 60 s.** The resolver re-sends the message and checks again every 2 seconds until the price differs. The UI says it's waiting for the price to move.
- **Duplicate or late message.** From SQS delivering twice, overlapping re-sends, or a guess whose save failed. The resolve write requires a matching `guessedAt`, so at worst the attempt is a no-op (§5).
- **Feed down.** Price shown with its age, guess buttons disabled once it's more than 3 s old, open guesses wait. The API tries Coinbase once a second per instance and otherwise answers from its cache (D2). The resolver keeps re-checking every 10 s (D5, D8).
- **First visit after idle.** The API fetches a fresh price on the first request. Only a Lambda cold start adds a delay (D10).
- **Player leaves with a guess open.** The message resolves it on time (D5).
- **Message lost.** Shouldn't happen (D5). If it did, `GET /state` resolves the guess once it's 2 minutes old, the next time the player visits.
- **Guess against an old price.** 409 `PRICE_EXPIRED`, for example after the tab froze. The next poll brings a fresh price (D4).
- **Two API instances, two prices.** A poll can return a price up to a second older than the last. The chart ignores it, and a guess against either is honored (D2).
- **Forgotten background tab.** Hidden tabs stop polling, so they don't make the API fetch prices nobody sees (D10).
- **Tab becomes visible again.** The client requests the chart's history again, filling the gap left while polling was paused (D11).
- **Coinbase trades unreachable.** `GET /price/history` returns 502. The chart starts empty and fills from polls. Guessing is unaffected (D11).
- **Two tabs.** Same `X-Player-Id`, same lock, both show the same countdown.
- **Double-click.** The second request finds the first guess open and gets 409 before sending anything. If both arrive at once, the conditional write refuses one, and its message later finds a guess with a different `guessedAt` (D5, §5).
- **Cleared storage / incognito.** New player at 0, who must choose a new alias. The old alias stays reserved. Accepted, documented.
- **Alias taken.** 409, and the UI asks for another. Two players claiming the same alias at once: the transaction lets exactly one through.
- **Malformed player ID or price time.** 400 before any database access.

## 8. Still open, to decide next

1. **Language and infrastructure-as-code.** Recommendation: TypeScript end to end, AWS CDK. One language for Lambda, frontend, infra, and tests. Alternatives: SAM, SST, Terraform.
2. **Frontend.** Recommendation: Vite + React, kept to a handful of components. Vanilla is viable given the UI is one screen.
3. **Frontend hosting.** S3 + CloudFront, or Amplify Hosting. Either is fine; CloudFront can also front the API under one origin if we later want cookies.
4. **Region.** Recommendation: `eu-north-1` (Stockholm). Coinbase works from the EU.
5. **Testing scope.** Recommendation: unit tests for the pure domain logic (resolution rule, staleness, state transitions) and one end-to-end smoke test against the deployed API. No DynamoDB Local.
6. **Price cadence.** One price per second: the API's cache lifetime (D2). Two per second is within limits if the UI feels sluggish; one per two seconds if we want more headroom. Trivial to change, but the client's poll rate, the chart's per-second history points and the 3-second guess window should change with it (D4, D11).

## 9. Rejected along the way

- **Shared one-minute rounds.** Breaks the "since the guess was made" clause and creates a late-vote exploit. See D1.
- **Lazy resolution on `GET /state`.** A losing player could choose when to come back. Kept only as a backup for a lost message. See D5.
- **WebSocket price feed in a long-running container.** More moving parts than a half-day assignment warrants; polling at 1 Hz is indistinguishable to the player.
- **Binance, CoinGecko.** See D3.
- **Background poller on a one-minute schedule.** The first design, built in slices 1–3: one Lambda fetched the price every second and resolved due guesses from an index. Keeping it idle needed visit tracking, start requests and overlapping runs. Replaced by on-demand prices and delayed messages. See D2, D5, D10.
- **Always-on poller.** Simpler than the first design, but runs and bills around the clock with nobody playing. See D10.
- **Storing price history for the chart.** Prices are only recorded while someone plays, so there would be nothing to show the first visitor. See D11.
- **Entry price from the latest price when the guess arrives.** Can differ from the price on screen. See D4.
- **Browser fetching chart history from Coinbase directly.** Exposes players to a third party and ties the client to Coinbase's API. See D11.

## 10. What we didn't do

### Authentication

**Why not.** The brief doesn't ask for it, and the game's fairness doesn't depend on it. The server accepts only prices it recorded, picks the resolution price (D4), and holds the lock for each player, so a signed-in player couldn't do anything an anonymous one can't. What auth would add is continuity: the same player on another device, after clearing storage, or in a private window, with their alias intact. The cost is that every reviewer would have to sign up and confirm an email before seeing the game. Building the sign-up and sign-in flows, email verification, and a test user for the smoke test would also take a large share of the half-day budget.

**How it would fit.** Add a Cognito user pool and attach API Gateway's built-in JWT authorizer to the HTTP API. The API then takes `playerId` from the token's `sub` claim instead of the `X-Player-Id` header. The data model, resolution logic, aliases and endpoints stay as they are. Existing anonymous players could keep their score and alias: on first sign-in the client sends its old ID once, and the server moves the player item to the new key and repoints the alias item, all in one transaction.

### Smaller omissions

- **Alias changes and moderation.** Aliases are fixed once chosen and not checked for offensive words. Without sign-up, a script could also reserve many aliases. API Gateway throttling would slow that down, but stopping it outright needs auth or a CAPTCHA.
- **Dead-letter queue.** A message that keeps failing for a reason other than Coinbase, such as a DynamoDB error, is delivered again every 30 seconds until SQS's retention period ends after 4 days. A dead-letter queue would set it aside for inspection after a few attempts. Without one, the `GET /state` backup still resolves the guess when the player returns (D5). Errors show in the resolver's logs either way.
- **A shared price cache.** Each API instance caches its own price (D2). At real scale, many instances would each call Coinbase once a second, and many open guesses would each fetch at every check (D5). A shared cache, or one fetcher writing for everyone, would keep that to one call, and a concurrency cap on the resolver's event source would bound the resolver's share. Not needed at this traffic.
