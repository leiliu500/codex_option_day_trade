import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { ContractSelector } from "../../src/engine/contractSelector";
import { LiveState } from "../../src/domain/state";
import { MarketRegime } from "../../src/domain/regimeTypes";
import type { SignalCandidate } from "../../src/domain/signalTypes";
import { allowedStrategies } from "../../src/domain/strategyPolicyEngine";
import { OptionStrategySelector } from "../../src/domain/optionStrategySelector";
import type { VolatilityDecision } from "../../src/types/optionStrategy";

test("policy prefers debit expression for bullish high-IV strong-up with long-call fallback and no naked short puts", () => {
  const strategies = allowedStrategies({
    marketRegime: MarketRegime.STRONG_UP,
    direction: "BULLISH",
    volatilityRegime: "HIGH_IV",
    optionsLevel: 3,
    hasLongStockPosition: false,
    enableCreditSpreads: true,
    enableIronCondor: false,
    enableLongStraddles: false,
  });

  assert.deepEqual(strategies, ["CALL_DEBIT_SPREAD", "LONG_CALL"]);
});

test("policy allows put credit spread only for stable bullish grind when credit spreads are enabled", () => {
  const strategies = allowedStrategies({
    marketRegime: MarketRegime.GRIND_UP,
    direction: "BULLISH",
    volatilityRegime: "HIGH_IV",
    optionsLevel: 3,
    hasLongStockPosition: false,
    enableCreditSpreads: true,
    enableIronCondor: false,
    enableLongStraddles: false,
  });

  assert.deepEqual(strategies, ["CALL_DEBIT_SPREAD", "LONG_CALL", "PUT_CREDIT_SPREAD"]);
});

test("policy allows iron condor only for neutral high-IV chop when explicitly enabled", () => {
  const strategies = allowedStrategies({
    marketRegime: MarketRegime.CHOP_DOJI,
    direction: "NEUTRAL",
    volatilityRegime: "HIGH_IV",
    optionsLevel: 3,
    hasLongStockPosition: false,
    enableCreditSpreads: false,
    enableIronCondor: true,
    enableLongStraddles: false,
  });

  assert.deepEqual(strategies, ["IRON_CONDOR"]);
});

test("selector chooses call debit spread for bullish high-IV strong-up when spread legs exist", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  addContract(state, "SPY260611C00100000", "call", 100, 0.55, 2, 2.1);
  addContract(state, "SPY260611C00105000", "call", 105, 0.25, 0.7, 0.8);
  const candidate = signalCandidate(MarketRegime.STRONG_UP, "BULLISH", 92);
  const singleLegCandidates = new ContractSelector(config).select(candidate, state, "2026-06-11T14:00:01.000Z");

  const decision = new OptionStrategySelector(config).select({
    candidate,
    singleLegCandidates,
    state,
    nowIso: "2026-06-11T14:00:01.000Z",
    volatilityDecision: volatility("HIGH_IV"),
  });

  assert.equal(decision.action, "OPEN");
  assert.equal(decision.selected?.strategy, "CALL_DEBIT_SPREAD");
  assert.equal(decision.selected?.orderClass, "mleg");
  assert.deepEqual(
    decision.selected?.legs.map((leg) => leg.positionIntent),
    ["buy_to_open", "sell_to_open"],
  );
});

test("selector keeps credit spread blocked when disabled even in high-IV grind-up", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  addContract(state, "SPY260611C00100000", "call", 100, 0.6, 2, 2.1);
  addContract(state, "SPY260611C00105000", "call", 105, 0.25, 0.7, 0.8);
  addContract(state, "SPY260611P00095000", "put", 95, -0.2, 0.7, 0.8);
  addContract(state, "SPY260611P00090000", "put", 90, -0.08, 0.2, 0.25);
  const candidate = signalCandidate(MarketRegime.GRIND_UP, "BULLISH", 90);
  const singleLegCandidates = new ContractSelector(config).select(candidate, state, "2026-06-11T14:00:01.000Z");

  const decision = new OptionStrategySelector(config).select({
    candidate,
    singleLegCandidates,
    state,
    nowIso: "2026-06-11T14:00:01.000Z",
    volatilityDecision: volatility("HIGH_IV"),
  });

  assert.equal(decision.action, "OPEN");
  assert.equal(decision.selected?.strategy, "CALL_DEBIT_SPREAD");
  assert.equal(decision.candidates.some((entry) => entry.strategy === "PUT_CREDIT_SPREAD"), false);
});

function addContract(
  state: LiveState,
  symbol: string,
  right: "call" | "put",
  strike: number,
  delta: number,
  bid: number,
  ask: number,
): void {
  state.contracts.set(symbol, {
    symbol,
    underlying_symbol: "SPY",
    expiration_date: "2026-06-11",
    strike_price: strike,
    right,
    status: "active",
    open_interest: 1000,
  });
  state.optionQuotes.set(symbol, {
    symbol,
    bid,
    ask,
    delta,
    implied_volatility: 0.4,
    theta: -0.01,
    received_at_utc: "2026-06-11T14:00:00.000Z",
  });
}

function signalCandidate(regime: MarketRegime, direction: "BULLISH" | "BEARISH", score: number): SignalCandidate {
  return {
    id: "c1",
    timestamp: "2026-06-11T14:00:00.000Z",
    underlying: "SPY",
    direction,
    regime,
    setupType: regime === MarketRegime.GRIND_UP ? "VWAP_PULLBACK" : "TREND_ACCELERATION",
    score,
    confidence: 0.9,
    triggerPrice: 100,
    invalidationPrice: 99,
    stopBps: 120,
    targetBps: 250,
    maxHoldSeconds: 900,
    allowEarlyEntry: false,
    needsConfirmationBars: 0,
    reasons: [regime],
    blockers: [],
    featureSnapshot: {
      trendEfficiency20: 0.7,
      vwapSlope3m: 0.5,
      ema21Slope3m: 0.5,
    } as SignalCandidate["featureSnapshot"],
  };
}

function volatility(regime: VolatilityDecision["regime"]): VolatilityDecision {
  return {
    regime,
    confidence: 0.8,
    reasons: [],
    features: {
      underlying: "SPY",
      chainIv: 0.4,
      atmIv: 0.4,
      ivRank20d: null,
      ivRank252d: null,
      ivPercentile20d: null,
      realizedVol20d: null,
      realizedVolIntraday: 0.2,
      ivToRvRatio: 2,
      ivMinusRv: 0.2,
      expectedMoveBpsToClose: 80,
      realizedMoveBpsFromOpen: 20,
      intradayIvZScore: null,
    },
  };
}
