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
- Current-ET-date expirations only, so the default universe is 0DTE.
- No new entries during the first 30 minutes after market open or the last 30 minutes before market close.
- Limit DAY orders only.
- No naked short options.
- No overnight positions; force flatten starts 30 minutes before market close.
- JSONL event sourcing for audit and replay.
- Human-facing run output, event envelopes, and historical reports include ET companion fields such as `started_at_et`, `received_at_et`, and `timestamp_et`; UTC fields remain present for deterministic replay.

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
npm run verify:history -- 2026-06-10 SPY --json
node dist/src/cli.js check-alpaca --config configs/paper.yaml --paper
node dist/src/cli.js replay-fixture tests/replay_fixtures/03_stale_option_quote_blocks_entry.jsonl --config configs/paper.yaml
```

`run --dry-run` validates config, enforces live guards, creates a session event log, and exits:

```bash
node dist/src/cli.js run --config configs/paper.yaml --paper --dry-run
```

`run --paper` performs the live workflow setup: account checks, buying-power/options approval checks, current underlying quote, current-date option universe, selected-symbol snapshots, selected-symbol option subscriptions, stock stream, option stream, and trade-update stream. Incoming stream events drive the shared `DomainEngine` for signals, contract selection, risk, execution, and exits.

`verify:history` fetches Alpaca historical stock bars plus selected 0DTE option bars/trades, computes per-timestamp Black-Scholes IV/Greeks, writes a replayable JSONL event log, and runs that event stream through the shared production domain engine.

Historical verification must not fork strategy behavior. The production decision path is `DomainEngine` plus `SignalEngine`, `ContractSelector`, `RiskEngine`, `ExecutionPolicy`, and `PositionManager`; both live trading and replay call that same path. Replay-only code is limited to historical data loading, converting historical bars/trades into the same event schema used by live streams, simulated broker fills, and reporting.

Risk caps such as `max_loss_per_trade_dollars`, `max_trades_per_day`, and `max_open_positions` accept `null` to disable that cap. The default configs use uncapped trade count/position sizing gates while keeping session, stale-data, spread, kill-switch, and long-options-only protections active.

## Project Layout

```text
src/config/      safe YAML config loader, env secret boundary, live-mode guard
src/domain/      event envelope, trading models, live state cache
src/data/        JSONL and in-memory event stores
src/engine/      feature/signal/selector/risk/execution/position/domain engine
src/engine/liveSessionController.ts  live before-market, market-event, and before-close workflow
src/broker/      Alpaca REST/WebSocket adapters and simulated execution adapter
src/replay/      JSONL fixture replay, replay clock, reports, parity helpers
tests/           unit tests and replay fixtures
```

## Production Notes

This codebase treats replay as verification, not as a separate trading bot. Recorded or fixture events are driven through the same production engine used by live mode. Alpaca-specific behavior is isolated behind adapters so API changes fail at integration boundaries instead of leaking into strategy logic.

Before any live deployment, run paper sessions first and verify no unlogged orders, orphan positions, stream disconnect handling gaps, or force-flatten failures.
