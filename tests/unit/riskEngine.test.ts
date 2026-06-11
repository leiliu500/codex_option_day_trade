import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { LiveState } from "../../src/domain/state";
import { RiskEngine } from "../../src/engine/riskEngine";
import type { TradeAction } from "../../src/domain/types";

test("risk gate blocks stale option quote before order submission", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const state = healthyState(config, "2026-06-11T14:15:00.000Z", "2026-06-11T14:14:00.000Z");
  const action = openAction("2026-06-11T14:15:00.000Z");
  const decision = new RiskEngine(config, configHash).evaluate(action, state, "2026-06-11T14:15:00.000Z");
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

test("risk gate blocks v1 short option opening legs", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T14:15:00.000Z";
  const state = healthyState(config, now, now);
  const action = openAction(now);
  action.legs[0].side = "sell";
  action.legs[0].position_intent = "sell_to_open";
  const decision = new RiskEngine(config, configHash).evaluate(action, state, now);
  assert.equal(decision.approved, false);
  assert.ok(decision.blocked_reasons.includes("naked_or_short_option_not_allowed"));
});

test("risk gate treats null risk caps as unlimited for otherwise valid long option entries", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T14:15:00.000Z";
  const state = healthyState(config, now, now);
  state.tradesToday = 100;
  state.positions.set("SPY260611P00100000", {
    symbol: "SPY260611P00100000",
    underlying_symbol: "SPY",
    strategy_type: "long_put",
    qty: 25,
    avg_entry_price: 3.5,
    opened_at_utc: now,
    force_flatten_at_utc: "2026-06-11T19:30:00.000Z",
    status: "open",
  });
  const action = openAction(now);
  action.limit_price = 3.72;
  action.max_loss_dollars = 372;

  const decision = new RiskEngine(config, configHash).evaluate(action, state, now);

  assert.equal(decision.approved, true);
  assert.deepEqual(decision.blocked_reasons, []);
});

test("risk gate allows stale-quote close actions when a fallback limit price is available", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const now = "2026-06-11T14:15:00.000Z";
  const state = healthyState(config, now, "2026-06-11T13:59:00.000Z");
  const action = openAction(now);
  action.action_type = "close";
  action.legs[0].side = "sell";
  action.legs[0].position_intent = "sell_to_close";
  action.limit_price = 0.9;
  action.max_loss_dollars = 0;

  const decision = new RiskEngine(config, configHash).evaluate(action, state, now);

  assert.equal(decision.approved, true);
  assert.equal(decision.blocked_reasons.includes("option_quote_stale"), false);
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
