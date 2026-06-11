import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { LiveState } from "../../src/domain/state";
import type { EventEnvelope } from "../../src/domain/types";

test("option snapshots refresh Greeks and IV without refreshing live bid ask quote state", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);

  state.applyEvent(event("option_snapshot", "2026-06-11T14:00:00.000Z", {
    symbol: "SPY260611C00100000",
    bid: 2.4,
    ask: 2.46,
    implied_volatility: 0.24,
    delta: 0.52,
    gamma: 0.08,
    theta: -0.22,
  }));

  const afterSnapshot = state.optionQuotes.get("SPY260611C00100000");
  assert.equal(afterSnapshot?.bid, undefined);
  assert.equal(afterSnapshot?.ask, undefined);
  assert.equal(afterSnapshot?.received_at_utc, undefined);
  assert.equal(afterSnapshot?.delta, 0.52);
  assert.equal(afterSnapshot?.gamma, 0.08);
  assert.equal(afterSnapshot?.theta, -0.22);
  assert.equal(afterSnapshot?.implied_volatility, 0.24);
  assert.equal(afterSnapshot?.snapshot_at_utc, "2026-06-11T14:00:00.000Z");
});

test("option quote stream refreshes bid ask and quote freshness without overwriting snapshot Greeks", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);

  state.applyEvent(event("option_snapshot", "2026-06-11T14:00:00.000Z", {
    symbol: "SPY260611C00100000",
    implied_volatility: 0.24,
    delta: 0.52,
    gamma: 0.08,
    theta: -0.22,
  }));
  state.applyEvent(event("option_quote", "2026-06-11T14:00:02.000Z", {
    symbol: "SPY260611C00100000",
    bid: 2.4,
    ask: 2.46,
    bid_size: 12,
    ask_size: 11,
    delta: 0.1,
  }));

  const quote = state.optionQuotes.get("SPY260611C00100000");
  assert.equal(quote?.bid, 2.4);
  assert.equal(quote?.ask, 2.46);
  assert.equal(quote?.received_at_utc, "2026-06-11T14:00:02.000Z");
  assert.equal(quote?.quote_event_at_utc, "2026-06-11T14:00:02.000Z");
  assert.equal(quote?.delta, 0.52);
});

test("option trade stream updates last trade without refreshing quote freshness", () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);

  state.applyEvent(event("option_quote", "2026-06-11T14:00:02.000Z", {
    symbol: "SPY260611C00100000",
    bid: 2.4,
    ask: 2.46,
  }));
  state.applyEvent(event("option_trade", "2026-06-11T14:00:05.000Z", {
    symbol: "SPY260611C00100000",
    last_trade_price: 2.44,
    last_trade_size: 3,
  }));

  const quote = state.optionQuotes.get("SPY260611C00100000");
  assert.equal(quote?.last_trade_price, 2.44);
  assert.equal(quote?.last_trade_size, 3);
  assert.equal(quote?.received_at_utc, "2026-06-11T14:00:02.000Z");
  assert.equal(quote?.trade_event_at_utc, "2026-06-11T14:00:05.000Z");
});

function event(eventType: "option_snapshot" | "option_quote" | "option_trade", receivedAt: string, normalized: Record<string, unknown>): EventEnvelope {
  return {
    event_id: `${eventType}-${receivedAt}`,
    run_id: "test-run",
    event_type: eventType,
    source: eventType === "option_snapshot" ? "alpaca_rest" : "alpaca_option_stream",
    event_at_utc: receivedAt,
    received_at_utc: receivedAt,
    sequence_num: 1,
    symbol: String(normalized.symbol),
    raw: {},
    normalized,
    schema_version: 1,
  };
}
