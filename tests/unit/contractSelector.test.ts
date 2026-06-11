import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { LiveState } from "../../src/domain/state";
import { MarketRegime } from "../../src/domain/regimeTypes";
import type { SignalCandidate } from "../../src/domain/signalTypes";
import { ContractSelector } from "../../src/engine/contractSelector";
import type { Signal } from "../../src/domain/types";

test("selector chooses tight near-delta call candidate", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  state.contracts.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    underlying_symbol: "SPY",
    expiration_date: "2026-06-11",
    strike_price: 100,
    right: "call",
    status: "active",
    open_interest: 1000,
  });
  state.optionQuotes.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    bid: 1,
    ask: 1.1,
    delta: 0.52,
    theta: -0.02,
    received_at_utc: "2026-06-11T14:00:00.000Z",
  });
  const signal: Signal = {
    signal_id: "s1",
    run_id: "r1",
    strategy_name: "orb_vwap_long_options",
    underlying_symbol: "SPY",
    direction: "bullish",
    confidence: 0.7,
    reason_codes: [],
    features: {},
    created_at_utc: "2026-06-11T14:00:00.000Z",
  };
  const selected = new ContractSelector(config).select(signal, state, "2026-06-11T14:00:01.000Z");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].contract.symbol, "SPY260611C00100000");
});

test("selector rejects contracts that do not expire on the current ET date", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  state.contracts.set("SPY260612C00100000", {
    symbol: "SPY260612C00100000",
    underlying_symbol: "SPY",
    expiration_date: "2026-06-12",
    strike_price: 100,
    right: "call",
    status: "active",
    open_interest: 1000,
  });
  state.optionQuotes.set("SPY260612C00100000", {
    symbol: "SPY260612C00100000",
    bid: 1,
    ask: 1.1,
    delta: 0.52,
    theta: -0.02,
    received_at_utc: "2026-06-11T14:00:00.000Z",
  });
  const signal: Signal = {
    signal_id: "s1",
    run_id: "r1",
    strategy_name: "orb_vwap_long_options",
    underlying_symbol: "SPY",
    direction: "bullish",
    confidence: 0.7,
    reason_codes: [],
    features: {},
    created_at_utc: "2026-06-11T14:00:00.000Z",
  };
  const selected = new ContractSelector(config).select(signal, state, "2026-06-11T14:00:01.000Z");
  assert.equal(selected.length, 0);
});

test("selector uses regime-specific higher-delta calls for grind-up candidates", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  for (const [symbol, delta] of [
    ["SPY260611C00100000", 0.5],
    ["SPY260611C00101000", 0.62],
  ] as const) {
    state.contracts.set(symbol, {
      symbol,
      underlying_symbol: "SPY",
      expiration_date: "2026-06-11",
      strike_price: symbol.endsWith("101000") ? 101 : 100,
      right: "call",
      status: "active",
      open_interest: 1000,
    });
    state.optionQuotes.set(symbol, {
      symbol,
      bid: 1,
      ask: 1.1,
      delta,
      theta: -0.02,
      received_at_utc: "2026-06-11T14:00:00.000Z",
    });
  }
  const candidate: SignalCandidate = {
    id: "candidate-1",
    timestamp: "2026-06-11T14:00:00.000Z",
    underlying: "SPY",
    direction: "BULLISH",
    regime: MarketRegime.GRIND_UP,
    setupType: "VWAP_PULLBACK",
    score: 90,
    confidence: 0.8,
    triggerPrice: 100,
    invalidationPrice: 99.8,
    stopBps: 250,
    targetBps: 500,
    maxHoldSeconds: 900,
    allowEarlyEntry: false,
    needsConfirmationBars: 0,
    reasons: [],
    blockers: [],
    featureSnapshot: {} as SignalCandidate["featureSnapshot"],
  };

  const selected = new ContractSelector(config).select(candidate, state, "2026-06-11T14:00:01.000Z");

  assert.deepEqual(
    selected.map((entry) => entry.contract.symbol),
    ["SPY260611C00101000"],
  );
});

test("selector rejects option candidates when recent mid is deteriorating", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  state.contracts.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    underlying_symbol: "SPY",
    expiration_date: "2026-06-11",
    strike_price: 100,
    right: "call",
    status: "active",
    open_interest: 1000,
  });
  state.optionQuotes.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    bid: 0.92,
    ask: 0.98,
    delta: 0.52,
    theta: -0.02,
    received_at_utc: "2026-06-11T14:00:03.000Z",
  });
  state.optionMidHistory.set("SPY260611C00100000", [
    { at: "2026-06-11T14:00:00.000Z", price: 1.1 },
    { at: "2026-06-11T14:00:01.000Z", price: 1.05 },
    { at: "2026-06-11T14:00:03.000Z", price: 0.95 },
  ]);
  const signal: Signal = {
    signal_id: "s1",
    run_id: "r1",
    strategy_name: "orb_vwap_long_options",
    underlying_symbol: "SPY",
    direction: "bullish",
    confidence: 0.7,
    reason_codes: [],
    features: {},
    created_at_utc: "2026-06-11T14:00:03.000Z",
  };

  const selected = new ContractSelector(config).select(signal, state, "2026-06-11T14:00:03.000Z");

  assert.equal(selected.length, 0);
});
