import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { LiveState } from "../../src/domain/state";
import type { EventEnvelope } from "../../src/domain/types";
import { MarketRegime } from "../../src/domain/regimeTypes";
import { RegimeEngine } from "../../src/domain/regimeEngine";
import { FeatureEngine } from "../../src/engine/featureEngine";

test("feature engine carries prior-close gap context into gap-and-go regime classification", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  for (let i = 0; i < 5; i += 1) {
    const at = `2026-06-11T13:3${i}:00.000Z`;
    const price = 101 + i * 0.12;
    state.applyEvent(underlyingBar(i, at, price));
  }

  const features = new FeatureEngine(config).regimeFeatures(state, "SPY", "2026-06-11T13:34:00.000Z");

  assert.ok(features);
  assert.ok(features.gapBps > 90);
  assert.equal(features.gapFillPct, 0);
  assert.equal(new RegimeEngine(config).classify(features).regime, MarketRegime.GAP_AND_GO_UP);
});

test("feature engine exposes requested slope, acceleration, and regression fields", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  for (let i = 0; i < 8; i += 1) {
    const at = `2026-06-11T14:0${i}:00.000Z`;
    const price = 100 + i * 0.2 + (i >= 6 ? 0.1 : 0);
    state.applyEvent(underlyingBar(i, at, price));
  }

  const features = new FeatureEngine(config).regimeFeatures(state, "SPY", "2026-06-11T14:07:00.000Z");

  assert.ok(features);
  assert.equal(features.ema9SlopeBpsPerMin, features.ema9Slope1m);
  assert.equal(features.ema21SlopeBpsPerMin, features.ema21Slope3m);
  assert.equal(features.vwapSlopeBpsPerMin, features.vwapSlope3m);
  assert.equal(features.ema9Acceleration, features.ema9Slope1m - features.ema9Slope3m);
  assert.equal(features.ema9AccelerationBps, features.ema9Acceleration);
  assert.equal(features.regressionSlopeBpsPerMin, features.regressionSlope);
  assert.ok(Number.isFinite(features.regressionSlope));
  assert.ok(features.regressionR2 >= 0 && features.regressionR2 <= 1);
});

function underlyingBar(index: number, at: string, price: number): EventEnvelope {
  return {
    event_id: `gap-bar-${index}`,
    run_id: "feature-test",
    event_type: "underlying_bar",
    source: "fixture",
    symbol: "SPY",
    event_at_utc: at,
    received_at_utc: at,
    sequence_num: index + 1,
    raw: {},
    normalized: {
      symbol: "SPY",
      previous_close: 100,
      open: 101,
      high: price + 0.04,
      low: price - 0.04,
      close: price,
      last_price: price,
      bid: price - 0.01,
      ask: price + 0.01,
      vwap: 101 + index * 0.06,
      relative_volume: 1.5,
      volume: 150000 + index * 1000,
      opening_range_high: 101.2,
      opening_range_low: 100.8,
    },
    schema_version: 1,
  };
}
