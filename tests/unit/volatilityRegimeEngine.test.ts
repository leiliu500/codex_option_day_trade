import test from "node:test";
import assert from "node:assert/strict";
import { classifyVolatility, ivPercentile, ivRank } from "../../src/domain/volatilityRegimeEngine";
import type { VolatilityFeatures } from "../../src/types/optionStrategy";

test("volatility classifier reports unknown when chain and atm IV are missing", () => {
  const decision = classifyVolatility(features({ chainIv: null, atmIv: null }));

  assert.equal(decision.regime, "UNKNOWN_IV");
  assert.deepEqual(decision.reasons, ["missing_iv"]);
});

test("volatility classifier treats IV rich versus realized volatility as high IV", () => {
  const decision = classifyVolatility(
    features({
      atmIv: 0.42,
      chainIv: 0.4,
      realizedVolIntraday: 0.2,
      ivToRvRatio: 2.1,
    }),
  );

  assert.equal(decision.regime, "HIGH_IV");
  assert.ok(decision.reasons.includes("high_iv_by_rank_or_iv_to_rv"));
});

test("volatility helpers compute IV rank and percentile with guards", () => {
  assert.ok(Math.abs((ivRank(0.3, [0.1, 0.2, 0.5]) ?? 0) - 0.5) < 1e-9);
  assert.equal(ivRank(0.3, [0.2, 0.2]), null);
  assert.equal(ivPercentile(0.3, [0.1, 0.3, 0.5]), 2 / 3);
});

function features(patch: Partial<VolatilityFeatures>): VolatilityFeatures {
  return {
    underlying: "SPY",
    chainIv: 0.2,
    atmIv: 0.2,
    ivRank20d: null,
    ivRank252d: null,
    ivPercentile20d: null,
    realizedVol20d: null,
    realizedVolIntraday: null,
    ivToRvRatio: null,
    ivMinusRv: null,
    expectedMoveBpsToClose: null,
    realizedMoveBpsFromOpen: null,
    intradayIvZScore: null,
    ...patch,
  };
}
