# Live Option Day Trader

TypeScript implementation of an event-driven Alpaca option day-trading workflow with a deterministic replay verifier. The live and replay paths share the same domain engine:

```text
state cache -> feature engine -> signal engine -> contract selector -> risk gate
            -> execution policy -> order/position state -> event store
```

The MVP is intentionally conservative:

- Paper mode by default.
- Live mode requires `ENABLE_LIVE_TRADING=true`, `--live`, `system.environment=live`, and `alpaca.paper=false`.
- Single-leg long calls/puts only.
- Limit DAY orders only.
- No naked short options.
- No overnight positions; force flatten logic is part of the position manager.
- JSONL event sourcing for audit and replay.

## Setup

```bash
npm install
cp .env.example .env
npm test
```

Do not commit `.env`. Alpaca credentials are read from environment variables only:

```bash
export ALPACA_API_KEY=...
export ALPACA_SECRET_KEY=...
export ALPACA_BASE_URL=https://paper-api.alpaca.markets
export ALPACA_DATA_URL=https://data.alpaca.markets
```

## Commands

```bash
npm run check:config
npm run replay:fixture
node dist/src/cli.js check-alpaca --config configs/paper.yaml --paper
node dist/src/cli.js replay-fixture tests/replay_fixtures/03_stale_option_quote_blocks_entry.jsonl --config configs/paper.yaml
```

`run --dry-run` validates config, enforces live guards, creates a session event log, and exits:

```bash
node dist/src/cli.js run --config configs/paper.yaml --paper --dry-run
```

## Project Layout

```text
src/config/      safe YAML config loader, env secret boundary, live-mode guard
src/domain/      event envelope, trading models, live state cache
src/data/        JSONL and in-memory event stores
src/engine/      feature/signal/selector/risk/execution/position/domain engine
src/broker/      Alpaca REST/WebSocket adapters and simulated execution adapter
src/replay/      JSONL fixture replay, replay clock, reports, parity helpers
tests/           unit tests and replay fixtures
```

## Production Notes

This codebase treats replay as verification, not as a separate trading bot. Recorded or fixture events are driven through the same production engine used by live mode. Alpaca-specific behavior is isolated behind adapters so API changes fail at integration boundaries instead of leaking into strategy logic.

Before any live deployment, run paper sessions first and verify no unlogged orders, orphan positions, stream disconnect handling gaps, or force-flatten failures.
