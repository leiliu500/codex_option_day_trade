import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { LiveState } from "../../src/domain/state";
import { ExecutionPolicy } from "../../src/engine/executionPolicy";
import { PositionManager } from "../../src/engine/positionManager";

test("position manager trails profitable option positions to protect gains", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T14:15:00.000Z";
  const state = new LiveState(config);
  state.positions.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    underlying_symbol: "SPY",
    strategy_type: "long_call",
    qty: 1,
    avg_entry_price: 1,
    opened_at_utc: "2026-06-11T14:00:00.000Z",
    last_mark_price: 1.08,
    highest_mark_price: 1.25,
    unrealized_pnl: 8,
    stop_loss_price: 0.88,
    take_profit_price: 1.6,
    force_flatten_at_utc: "2026-06-11T19:30:00.000Z",
    status: "open",
  });
  state.optionQuotes.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    bid: 1.07,
    ask: 1.09,
    received_at_utc: now,
  });

  const actions = new PositionManager(config, new ExecutionPolicy(config, "test-run")).evaluateExits(state, now);

  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].exit_reason, ["trailing_stop"]);
});

test("position manager defers loss exits while underlying trend still supports position", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T14:15:00.000Z";
  const state = new LiveState(config);
  state.underlyings.set("SPY", {
    symbol: "SPY",
    last_price: 99,
    vwap: 100,
    opening_range_high: 100.5,
    opening_range_low: 99.5,
    last_received_at_utc: now,
  });
  state.priceHistory.set("SPY", [
    { at: "2026-06-11T14:10:00.000Z", price: 100 },
    { at: now, price: 99 },
  ]);
  state.positions.set("SPY260611P00100000", {
    symbol: "SPY260611P00100000",
    underlying_symbol: "SPY",
    strategy_type: "long_put",
    qty: 1,
    avg_entry_price: 2,
    opened_at_utc: "2026-06-11T14:00:00.000Z",
    last_mark_price: 1.7,
    highest_mark_price: 2,
    unrealized_pnl: -30,
    stop_loss_price: 1.76,
    take_profit_price: 3.2,
    force_flatten_at_utc: "2026-06-11T19:30:00.000Z",
    status: "open",
  });
  state.optionQuotes.set("SPY260611P00100000", {
    symbol: "SPY260611P00100000",
    bid: 1.69,
    ask: 1.71,
    received_at_utc: now,
  });

  const actions = new PositionManager(config, new ExecutionPolicy(config, "test-run")).evaluateExits(state, now);

  assert.equal(actions.length, 0);
});
