# Runbook

## Before Market

- Credentials are loaded from the environment.
- `configs/paper.yaml` or reviewed live config is selected.
- `ENABLE_LIVE_TRADING=false` unless intentionally running live.
- `npm test` passes.
- `lotd check-alpaca --paper` can reach the account.
- Account status, options approval, and buying power pass startup checks.
- Event log directory is writable.
- Confirm CLI output shows `timezone: America/New_York`; inspect event logs and replay reports with `*_et` fields for market-time checks.
- Kill switch state is known.
- Universe DTE is `0` to select contracts expiring on the current ET date only.
- New entries are blocked until 30 minutes after market open.
- Option stream subscriptions contain selected symbols only, never whole-chain wildcards.

## During Market

- Required streams are connected and fresh.
- New entries are blocked on stale stock, stale option, or degraded stream health.
- Every decision and risk block is present in the event log.
- Open orders and positions reconcile with Alpaca.
- Daily realized loss stays inside configured limits.

## End Of Day

- New entries stop at configured last-entry time.
- Positions are flattened 30 minutes before the configured market close.
- New entries remain blocked during the last 30 minutes before market close.
- Open orders are cancelled before the configured cancel-open-orders time.
- No option positions remain after close.
- Replay is run against the recorded event log.
- Final trade log event is written to the session event log.

## Emergency

1. Enable kill switch.
2. Cancel open orders.
3. Flatten positions if quotes are valid and it is safe to do so.
4. Verify broker positions manually.
5. Stop the bot.
6. Preserve JSONL event logs.
7. Replay the incident event log before restarting.
