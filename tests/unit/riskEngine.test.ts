import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { LiveState } from "../../src/domain/state";
import { RiskEngine } from "../../src/engine/riskEngine";
import type { TradeAction } from "../../src/domain/types";

test("risk gate blocks stale option quote before order submission", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const state = healthyState(config, "2026-06-11T14:00:00.000Z", "2026-06-11T13:59:00.000Z");
  const action = openAction("2026-06-11T14:00:00.000Z");
  const decision = new RiskEngine(config, configHash).evaluate(action, state, "2026-06-11T14:00:00.000Z");
  assert.equal(decision.approved, false);
  assert.ok(decision.blocked_reasons.includes("option_quote_stale"));
});

test("risk gate blocks opening trades during the first 30 minutes after market open", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T13:45:00.000Z";
  const state = healthyState(config, now, now);
  const decision = new RiskEngine(config, configHash).evaluate(openAction(now), state, now);
  assert.equal(decision.approved, false);
  assert.ok(decision.blocked_reasons.includes("outside_entry_window"));
});

test("risk gate blocks opening trades during the last 30 minutes before market close", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T19:31:00.000Z";
  const state = healthyState(config, now, now);
  const decision = new RiskEngine(config, configHash).evaluate(openAction(now), state, now);
  assert.equal(decision.approved, false);
  assert.ok(decision.blocked_reasons.includes("outside_entry_window"));
});

function healthyState(config: ReturnType<typeof loadConfig>["config"], nowIso: string, optionQuoteIso: string): LiveState {
  const state = new LiveState(config);
  state.underlyings.set("SPY", {
    symbol: "SPY",
    last_price: 101,
    bid: 100.99,
    ask: 101.01,
    last_received_at_utc: nowIso,
  });
  for (const name of ["stock", "option", "trading"]) {
    state.streamHealth.set(name, {
      name,
      connected: true,
      authenticated: true,
      last_message_at_utc: nowIso,
      reconnect_count: 0,
      subscriptions: [],
    });
  }
  state.contracts.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    underlying_symbol: "SPY",
    expiration_date: "2026-06-11",
    strike_price: 100,
    right: "call",
    status: "active",
    open_interest: 500,
  });
  state.optionQuotes.set("SPY260611C00100000", {
    symbol: "SPY260611C00100000",
    bid: 0.9,
    ask: 0.98,
    received_at_utc: optionQuoteIso,
  });
  return state;
}

function openAction(nowIso: string): TradeAction {
  return {
    action_id: "a1",
    client_order_id: "lotd-test",
    action_type: "open",
    strategy_type: "long_call",
    underlying_symbol: "SPY",
    legs: [{ symbol: "SPY260611C00100000", side: "buy", ratio_qty: 1, position_intent: "buy_to_open" }],
    qty: 1,
    order_type: "limit",
    limit_price: 0.94,
    time_in_force: "day",
    max_loss_dollars: 94,
    entry_reason: [],
    exit_reason: [],
    created_at_utc: nowIso,
  };
}
