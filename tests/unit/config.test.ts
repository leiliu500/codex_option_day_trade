import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTradingMode, loadConfig } from "../../src/config/config";

test("paper config loads with stable defaults", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  assert.equal(config.system.environment, "paper");
  assert.equal(config.system.timezone, "America/New_York");
  assert.equal(process.env.TZ, "America/New_York");
  assert.equal(config.watchlist.underlyings[0], "SPY");
  assert.equal(config.universe.dte_min, 0);
  assert.equal(config.universe.dte_max, 0);
  assert.equal(config.session.entry_start_buffer_minutes, 30);
  assert.equal(config.session.first_entry_time_et, "10:00:00");
  assert.equal(config.session.last_entry_time_et, "15:30:00");
  assert.equal(config.session.force_flatten_time_et, "15:30:00");
  assert.equal(config.risk.max_loss_per_trade_dollars, null);
  assert.equal(config.risk.max_daily_loss_dollars, null);
  assert.equal(config.risk.max_trades_per_day, null);
  assert.equal(config.risk.max_open_positions, null);
  assert.equal(config.risk.max_open_orders, null);
  assert.equal(config.risk.max_position_notional_dollars, null);
  assert.equal(config.volatility.high_iv_to_rv_min, 1.25);
  assert.equal(config.option_strategy.enable_debit_spreads, true);
  assert.equal(config.option_strategy.enable_credit_spreads, false);
  assert.equal(config.option_strategy.enable_iron_condor, false);
  assert.equal(config.option_strategy.allow_naked_short_options, false);
  assert.equal(config.option_strategy.max_loss_per_trade_dollars, null);
  assert.equal(config.strategy.entry_confirmation_seconds, 0);
  assert.equal(config.strategy.max_opening_range_bps, 25);
  assert.equal(config.regime.entry_window.normal_first_entry_delay_minutes, 30);
  assert.equal(config.regime.grind.min_short_momentum_bps, 3);
  assert.equal(config.regime.candidate_scores.min_wide_directional_score, 65);
  assert.equal(config.regime.repeat_entry.strong_trend_cooldown_sec, 30);
  assert.equal(config.regime.repeat_entry.min_new_move_bps_default, 2);
  assert.deepEqual(config.regime.contract_selection.delta_by_regime.GRIND_UP_CALL, [0.55, 0.75]);
  assert.deepEqual(config.regime.contract_selection.delta_by_regime.WIDE_DIRECTIONAL_UP_CALL, [0.35, 0.8]);
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
