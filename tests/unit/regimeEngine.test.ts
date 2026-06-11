import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { RegimeEngine } from "../../src/domain/regimeEngine";
import { MarketRegime, type RegimeFeatureSnapshot, type RegimeSnapshot } from "../../src/domain/regimeTypes";
import { SignalEngine } from "../../src/engine/signalEngine";
import { CandidateRanker } from "../../src/engine/candidateRanker";
import { LiveState } from "../../src/domain/state";

test("classifies strong directional regimes", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const engine = new RegimeEngine(config);

  assert.equal(engine.classify(features({})).regime, MarketRegime.STRONG_UP);
  assert.equal(
    engine.classify(
      features({
        price: 99,
        vwap: 100,
        priceToVwapBps: -100,
        ema9SlopeBpsPerMin: -3,
        ema21SlopeBpsPerMin: -1.2,
        vwapSlopeBpsPerMin: -0.8,
        ema9AccelerationBps: -0.1,
        returnBps1m: -10,
        regressionSlopeBpsPerMin: -4,
        higherLowCount: 0,
        lowerHighCount: 3,
      }),
    ).regime,
    MarketRegime.STRONG_DOWN,
  );
});

test("classifies grind regimes without requiring 15 bps short momentum", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const engine = new RegimeEngine(config);

  assert.equal(
    engine.classify(
      features({
        price: 101,
        vwap: 100.9,
        priceToVwapBps: 9,
        openingRangeHigh: 105,
        priceToOrHighBps: -381,
        ema9SlopeBpsPerMin: 0.7,
        ema21SlopeBpsPerMin: 0.45,
        vwapSlopeBpsPerMin: 0.3,
        trendEfficiency10: 0.48,
        trendEfficiency20: 0.52,
        regressionR2: 0.4,
        shortMomentumBps: 5,
        realizedVolBps1m: 8,
        higherLowCount: 3,
        pullbackDepthBps: 8,
      }),
    ).regime,
    MarketRegime.GRIND_UP,
  );

  assert.equal(
    engine.classify(
      features({
        price: 99,
        vwap: 99.1,
        priceToVwapBps: -10,
        ema9SlopeBpsPerMin: -0.7,
        ema21SlopeBpsPerMin: -0.45,
        vwapSlopeBpsPerMin: -0.3,
        trendEfficiency10: 0.48,
        trendEfficiency20: 0.52,
        regressionR2: 0.4,
        shortMomentumBps: -5,
        realizedVolBps1m: 8,
        higherLowCount: 0,
        lowerHighCount: 3,
        pullbackDepthBps: 8,
      }),
    ).regime,
    MarketRegime.GRIND_DOWN,
  );
});

test("classifies chop, whipsaw, reversal, and gap-and-go regimes", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const engine = new RegimeEngine(config);

  assert.equal(
    engine.classify(
      features({
        priceToVwapBps: 1,
        ema9SlopeBpsPerMin: 0.1,
        ema21SlopeBpsPerMin: 0.1,
        vwapSlopeBpsPerMin: 0.05,
        trendEfficiency10: 0.2,
        regressionR2: 0.1,
        vwapCrossCount10: 4,
        alternatingBarRate10: 0.6,
        dojiRate10: 0.5,
      }),
    ).regime,
    MarketRegime.CHOP_DOJI,
  );

  assert.equal(
    engine.classify(
      features({
        openingRangeBps: 40,
        rangeExpansionRatio: 2,
        vwapCrossCount10: 4,
        alternatingBarRate10: 0.6,
        trendEfficiency10: 0.25,
      }),
    ).regime,
    MarketRegime.HIGH_VOL_WHIPSAW,
  );

  assert.equal(
    engine.classify(
      features({
        price: 100.5,
        vwap: 100,
        priceToVwapBps: 50,
        priceToOrHighBps: 0,
        ema9SlopeBpsPerMin: 0.4,
        ema21SlopeBpsPerMin: -0.1,
        vwapSlopeBpsPerMin: 0.1,
        ema9AccelerationBps: 1,
        regressionSlopeBpsPerMin: 0.2,
        returnBps1m: 6,
        wickPct: 0.6,
        trendEfficiency10: 0.4,
        regressionR2: 0.3,
      }),
    ).regime,
    MarketRegime.REVERSAL_UP,
  );

  assert.equal(
    engine.classify(
      features({
        gapBps: 35,
        gapFillPct: 0.1,
        relativeVolume: 1.4,
      }),
    ).regime,
    MarketRegime.GAP_AND_GO_UP,
  );
});

test("grind-up candidate generation does not require opening-range breakout or short-momentum impulse", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const snapshot: RegimeSnapshot = {
    regime: MarketRegime.GRIND_UP,
    direction: "BULLISH",
    confidence: 0.8,
    tradable: true,
    reasons: ["grind_up_structure"],
    blockers: [],
    features: features({
      price: 101,
      vwap: 100.8,
      priceToVwapBps: 20,
      openingRangeHigh: 105,
      priceToOrHighBps: -381,
      ema9: 100.9,
      ema21: 100.5,
      ema9SlopeBpsPerMin: 1.2,
      ema21SlopeBpsPerMin: 0.5,
      vwapSlopeBpsPerMin: 0.35,
      ema9AccelerationBps: 0.2,
      trendEfficiency20: 0.55,
      regressionR2: 0.45,
      higherLowCount: 3,
      pullbackDepthBps: 6,
      shortMomentumBps: 0,
      priorHigh1m: 100.9,
      priorHigh3m: 100.95,
    }),
  };

  const candidates = new SignalEngine(config, "test-run").generateCandidates(snapshot, "SPY", new LiveState(config), "2026-06-11T14:10:00.000Z");
  const ranked = new CandidateRanker(config).rank(candidates);

  assert.ok(ranked.some((candidate) => candidate.setupType === "VWAP_PULLBACK"));
  assert.ok(ranked.every((candidate) => candidate.direction === "BULLISH"));
});

function features(overrides: Partial<RegimeFeatureSnapshot>): RegimeFeatureSnapshot {
  const base: RegimeFeatureSnapshot = {
    price: 101,
    vwap: 100,
    ema9: 100.8,
    ema21: 100.2,
    ema50: 99.8,
    priceToVwapBps: 100,
    openingRangeHigh: 100.5,
    openingRangeLow: 99.5,
    openingRangeMid: 100,
    openingRangeBps: 10,
    priceToOrHighBps: 49.75,
    priceToOrLowBps: 150.75,
    gapBps: 0,
    gapFillPct: 0,
    ema9Slope1m: 3,
    ema9Slope3m: 2.5,
    ema21Slope3m: 1.2,
    vwapSlope3m: 0.8,
    ema9Acceleration: 0.5,
    regressionSlope: 3,
    ema9SlopeBpsPerMin: 3,
    ema21SlopeBpsPerMin: 1.2,
    ema50SlopeBpsPerMin: 0.5,
    vwapSlopeBpsPerMin: 0.8,
    ema9AccelerationBps: 0,
    ema21AccelerationBps: 0,
    regressionSlopeBpsPerMin: 3,
    regressionR2: 0.6,
    trendEfficiency10: 0.6,
    trendEfficiency20: 0.6,
    realizedVolBps1m: 10,
    atrBps1m: 8,
    rangeExpansionRatio: 1,
    candleBodyPct: 0.8,
    wickPct: 0.2,
    dojiRate10: 0.1,
    vwapCrossCount10: 0,
    alternatingBarRate10: 0.1,
    higherLowCount: 3,
    lowerHighCount: 0,
    pullbackDepthBps: 5,
    returnBps1m: 8,
    returnBps3m: 18,
    returnBps5m: 30,
    shortMomentumBps: 10,
    momentumAccelerationBps: 2,
    relativeVolume: 1,
    priorHigh1m: 100.9,
    priorLow1m: 100.2,
    priorHigh3m: 100.95,
    priorLow3m: 100.1,
    compressionRangeBps: 20,
  };
  return { ...base, ...overrides } as RegimeFeatureSnapshot;
}
