import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTradingMode, loadConfig } from "../../src/config/config";

test("paper config loads with stable defaults", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  assert.equal(config.system.environment, "paper");
  assert.equal(config.watchlist.underlyings[0], "SPY");
  assert.equal(config.universe.dte_min, 0);
  assert.equal(config.universe.dte_max, 0);
  assert.equal(config.session.entry_start_buffer_minutes, 45);
  assert.equal(config.session.first_entry_time_et, "10:15:00");
  assert.equal(config.session.last_entry_time_et, "15:30:00");
  assert.equal(config.session.force_flatten_time_et, "15:30:00");
  assert.equal(config.risk.max_loss_per_trade_dollars, null);
  assert.equal(config.risk.max_daily_loss_dollars, null);
  assert.equal(config.risk.max_trades_per_day, null);
  assert.equal(config.risk.max_open_positions, null);
  assert.equal(config.risk.max_open_orders, null);
  assert.equal(config.risk.max_position_notional_dollars, null);
  assert.equal(config.strategy.entry_confirmation_seconds, 0);
  assert.equal(config.strategy.max_opening_range_bps, 25);
  assert.equal(config.exit.defer_loss_exits_while_underlying_trend_valid, true);
  assert.match(configHash, /^[a-f0-9]{64}$/);
});

test("live mode requires env and live config confirmation", () => {
  const { config } = loadConfig("configs/paper.yaml");
  assert.throws(
    () => assertSafeTradingMode(config, { live: true }, { ENABLE_LIVE_TRADING: "false" } as NodeJS.ProcessEnv),
    /Live trading refused/,
  );
});
