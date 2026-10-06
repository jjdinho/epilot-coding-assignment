# BTC Up/Down

A web game: guess whether the BTC/USD price will be higher or lower in a minute.

**Play it at https://d2xt4659279tip.cloudfront.net**

Pick an alias, then watch the live price and a chart of its last minute. Press Up or Down. At least 60 seconds later, once the price has moved, the guess resolves: +1 if you were right, −1 if not. One guess can be open at a time. Your score stays with your browser, so you can close the tab and come back, even with a guess open: it resolves on time without you.

## Architecture

A static React page on S3 and CloudFront polls an HTTP API (API Gateway and one Lambda) every second while its tab is visible. The API fetches the price from Coinbase's public ticker when a page asks for it, at most once a second per Lambda instance. A guess takes the price the API holds when it arrives, which must be under 3 seconds old. The API then sends an SQS message delayed by 60 seconds and saves the guess in DynamoDB. When the message arrives, a resolver Lambda fetches the price. If the price has moved, it scores the guess with a conditional write, so a duplicate message can't score it twice. If it hasn't, the resolver sends the message again with a 2-second delay. Nothing is scheduled, so nothing runs while nobody plays. The chart's last minute comes from Coinbase's recent trades, through the API. All of it is one CDK stack in `eu-north-1`. The decisions behind it, and the alternatives we rejected, are in [docs/design.md](docs/design.md).

## Layout

- `backend/`: the API and resolver Lambdas. Pure game rules live in `backend/src/domain`, with their tests.
- `frontend/`: Vite + React single page, styled with Tailwind and shadcn/ui (generated components in `frontend/src/components/ui`).
- `infra/`: the CDK app, one stack in `eu-north-1`.
- `smoke/`: smoke test against the deployed API.

## Local setup

Needs Node 22 (the Lambda runtime) and npm. The backend runs only in AWS, so there's no local server. To try the app, use the live URL above or deploy your own stack.

```sh
git clone https://github.com/jjdinho/epilot-coding-assignment.git
cd epilot-coding-assignment
npm install
```

## Tests

```sh
npm test        # unit tests
npm run build   # typecheck everything and build the frontend
npm run synth   # cdk synth, after npm run build; needs no AWS credentials
```

The unit tests cover the pure rules: player ID, alias and price checks, price staleness, scoring, reducing Coinbase trades to the chart's history, and the client's countdown, chart window, price trend, line colours and guess history. The Lambda handlers stay thin and aren't unit-tested. The smoke test covers them.

## Deploy

Needs an AWS account, and credentials for it in your shell, for example with `AWS_PROFILE`. The stack is called `BtcUpDown`.

Once per account, bootstrap CDK in the region:

```sh
npx cdk bootstrap aws://<account-id>/eu-north-1
```

Then build and deploy:

```sh
npm run deploy
```

It doesn't stop to confirm IAM changes (`requireApproval` is `never` in `infra/cdk.json`). The first deploy takes about 4 minutes, mostly for CloudFront. Later ones take about a minute. The stack outputs `SiteUrl`, the game, and `ApiUrl`. To read them again later, with the AWS CLI:

```sh
aws cloudformation describe-stacks --stack-name BtcUpDown --region eu-north-1 --query 'Stacks[0].Outputs'
```

## Smoke test

Runs against a deployed API:

```sh
API_URL=<ApiUrl> npm run smoke
```

Against the live stack, that's `API_URL=https://d4zs1odcjl.execute-api.eu-north-1.amazonaws.com npm run smoke`.

It plays one new player through the API. It prints a ✓ for each check that passes, and stops at the first that fails with a ✗ and the assertion. It covers the player ID and alias checks, the chart's history and a fresh price. Then it sends guesses the API must refuse: from an unknown player, with a bad direction, and while a guess is open. Last, it makes a guess and waits for the resolver to score it. The whole run takes a little over a minute. Each run reserves an alias of the form `smoke_xxxxxxxx` for good, as any player does.

## Trade-offs

The design accepts these, for a game this size. The D numbers are the decisions in [docs/design.md](docs/design.md#4-decisions).

- **The entry price can differ from the headline (D4).** A guess takes the price the server holds when it arrives, not the one on screen. The page polls once a second, so the two are often the same and otherwise up to a second of movement apart, as likely for the player as against. The open-guess panel shows the entry price as soon as the guess is accepted. The alternative, honoring the price the player names, would let anyone calling the API pick the best of the last few seconds.
- **A lost message resolves late (D5).** Each guess resolves from its own SQS message. If one were lost, the guess would resolve on the player's next visit, once it's 2 minutes old, at that moment's price rather than on time.
- **The player ID is the only credential (D6).** There's no sign-in. The browser keeps a random ID in local storage, and the last five results next to it, since the server stores only the latest. Clearing storage, a private window or another device starts a new player at 0. Anyone holding the ID plays as that player, so the page never shows it.
- **A cleared player's alias stays reserved (D9).** A player who clears storage can't reclaim their alias. It stays with the abandoned record, because without sign-in the server can't tell it's the same person.
- **The chart is approximate, and the price can step back (D11, D2).** The chart's history is the last trade in each second, while the API samples partway through a second, so the chart can show a price the server never fetched. The guess panel shows the entry and resolution prices, which are the ones that count. Each API instance also caches its own price, so the headline price can briefly step back when two instances hold prices fetched a moment apart.
- **Coinbase calls scale with use (D2).** One per second per warm API instance, plus one per open guess at each check. That's a few calls a second at this traffic, well under Coinbase's public limit of 10 requests a second. At scale, a shared price cache would be needed.

## What we didn't do

More in [design §10](docs/design.md#10-what-we-didnt-do).

- **Authentication.** The brief doesn't ask for it, and fairness doesn't depend on it: the server picks both the entry and the resolution price itself. Sign-in would add continuity across devices, at the cost of every reviewer signing up first. It would fit as a Cognito user pool with API Gateway's JWT authorizer, taking the player ID from the token instead of the `X-Player-Id` header.
- **Alias changes and moderation.** Aliases are fixed once chosen and not checked for offensive words. A script could reserve many of them.
- **A dead-letter queue.** A message that keeps failing for a reason other than Coinbase is delivered again every 30 seconds until SQS deletes it after 4 days. The `GET /state` backup still resolves the guess when the player returns, and the error shows in the resolver's log.
- **A shared price cache, and a cap on the resolver's concurrency.** Both answer a scale the app isn't at (D2).
- **A mobile layout.** Phones get the same single column as desktops: it fits, but isn't designed for a small screen. The guess controls would gain most. On mobile, the Up and Down buttons, the price and the score would stick to the bottom of the screen, so they stay in reach while the player scrolls through results.
