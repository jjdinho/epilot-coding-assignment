# BTC Up/Down

A web game: guess whether the BTC/USD price will be higher or lower in one minute. A correct guess scores +1, a wrong one −1. Prices come from the Coinbase Exchange public ticker, and scores are kept in DynamoDB.

The design and its trade-offs are in [docs/design.md](docs/design.md). The build order is in [docs/slices.md](docs/slices.md).

## Layout

- `backend/`: the API and poller Lambdas. Pure game rules live in `backend/src/domain`, with their tests.
- `frontend/`: Vite + React single page.
- `infra/`: the CDK app, one stack in `eu-north-1`.
- `smoke/`: smoke test against the deployed API.

## Local setup

Needs Node 22.

```sh
npm install
npm test        # unit tests
npm run build   # typecheck everything and build the frontend
npm run synth   # cdk synth, after npm run build; needs no AWS credentials
```

## Deploy

Use AWS credentials for the target account, for example with `AWS_PROFILE`.

Once per account, bootstrap CDK in the region:

```sh
npx cdk bootstrap aws://<account-id>/eu-north-1
```

Then build and deploy:

```sh
npm run deploy
```

The stack outputs `SiteUrl` (the game) and `ApiUrl`.

## Smoke test

Runs against the deployed API. The poller starts within a minute of the first deploy, so wait for it before running this.

```sh
API_URL=<ApiUrl> npm run smoke
```

It takes over a minute, because it waits for the poller to resolve a guess. Each run reserves an alias of the form `smoke_xxxxxxxx` for good.
