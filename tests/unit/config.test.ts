import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTradingMode, loadConfig } from "../../src/config/config";

test("paper config loads with stable defaults", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  assert.equal(config.system.environment, "paper");
  assert.equal(config.watchlist.underlyings[0], "SPY");
  assert.equal(config.universe.dte_min, 0);
  assert.equal(config.universe.dte_max, 0);
  assert.equal(config.session.first_entry_time_et, "10:00:00");
  assert.equal(config.session.last_entry_time_et, "15:30:00");
  assert.equal(config.session.force_flatten_time_et, "15:30:00");
  assert.match(configHash, /^[a-f0-9]{64}$/);
});

test("live mode requires env and live config confirmation", () => {
  const { config } = loadConfig("configs/paper.yaml");
  assert.throws(
    () => assertSafeTradingMode(config, { live: true }, { ENABLE_LIVE_TRADING: "false" } as NodeJS.ProcessEnv),
    /Live trading refused/,
  );
});
