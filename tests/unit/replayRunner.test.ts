import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import type { EventEnvelope } from "../../src/domain/types";
import { sha256 } from "../../src/util/hash";
import { runEventsThroughProductionEngine, runReplayFromJsonl } from "../../src/replay/replayRunner";

test("bullish fixture produces deterministic approved order intent", async () => {
  const { config } = loadConfig("configs/paper.yaml");
  config.session.first_entry_time_et = "10:00:00";
  config.strategy.entry_confirmation_seconds = 0;
  config.strategy.max_opening_range_bps = null;
  const result = await runEventsThroughProductionEngine({ inputEvents: bullishRegimeReplayEvents(), config, configHash: sha256(config) });
  const report = result.report;
  assert.ok(report.orders_simulated >= 1);
  assert.equal(report.blocked_decisions, 0);
  assert.equal(report.mismatches.length, 0);
});

test("stale option fixture does not submit an order", async () => {
  const report = await runReplayFromJsonl({
    eventPath: "tests/replay_fixtures/03_stale_option_quote_blocks_entry.jsonl",
    configPath: "configs/paper.yaml",
  });
  assert.equal(report.events_processed, 10);
  assert.equal(report.orders_simulated, 0);
});

test("production replay gates repeated entries from the same active setup", async () => {
  const { config } = loadConfig("configs/paper.yaml");
  config.session.first_entry_time_et = "10:00:00";
  config.strategy.entry_confirmation_seconds = 0;
  config.strategy.max_opening_range_bps = null;
  const inputEvents = bullishRegimeReplayEvents(5);

  const result = await runEventsThroughProductionEngine({ inputEvents, config, configHash: sha256(config) });

  assert.ok(result.report.orders_simulated >= 1);
  assert.ok(
    result.outputEvents.some((event) => {
      const reasons = event.normalized.reason_codes;
      return event.event_type === "decision_no_trade" && Array.isArray(reasons) && reasons.includes("entry_setup_not_fresh");
    }),
  );
});

test("production replay requires persistent setup confirmation before opening", async () => {
  const { config } = loadConfig("configs/paper.yaml");
  config.session.first_entry_time_et = "10:00:00";
  config.strategy.entry_confirmation_seconds = 60;
  config.strategy.max_opening_range_bps = null;
  const inputEvents = bullishRegimeReplayEvents(7);

  const result = await runEventsThroughProductionEngine({ inputEvents, config, configHash: sha256(config) });

  assert.ok(result.report.orders_simulated >= 1);
  assert.ok(
    result.outputEvents.some((event) => {
      const reasons = event.normalized.reason_codes;
      return event.event_type === "decision_no_trade" && Array.isArray(reasons) && reasons.includes("entry_setup_waiting_for_confirmation");
    }),
  );
});

function bullishRegimeReplayEvents(minutes = 12): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  let sequence = 1;
  events.push({
    event_id: "regime-contract",
    run_id: "fixture-regime",
    event_type: "option_contract",
    source: "fixture",
    symbol: "SPY260611C00100000",
    event_at_utc: "2026-06-11T14:00:00.000Z",
    received_at_utc: "2026-06-11T14:00:00.000Z",
    sequence_num: sequence++,
    raw: {},
    normalized: {
      symbol: "SPY260611C00100000",
      underlying_symbol: "SPY",
      expiration_date: "2026-06-11",
      strike_price: 100,
      right: "call",
      status: "active",
      open_interest: 1000,
    },
    schema_version: 1,
  });
  for (let i = 0; i < minutes; i += 1) {
    const at = `2026-06-11T14:${String(i).padStart(2, "0")}:00.000Z`;
    for (const name of ["stock", "option", "trading"]) {
      events.push({
        event_id: `regime-health-${name}-${i}`,
        run_id: "fixture-regime",
        event_type: "stream_health",
        source: "fixture",
        received_at_utc: at,
        sequence_num: sequence++,
        raw: {},
        normalized: {
          name,
          connected: true,
          authenticated: true,
          last_message_at_utc: at,
          reconnect_count: 0,
          subscriptions: name === "stock" ? ["SPY"] : name === "option" ? ["SPY260611C00100000"] : ["trade_updates"],
        },
        schema_version: 1,
      });
    }
    const price = 100 + i * 0.18;
    const vwap = 100 + i * 0.08;
    events.push({
      event_id: `regime-option-quote-${i}`,
      run_id: "fixture-regime",
      event_type: "option_quote",
      source: "fixture",
      symbol: "SPY260611C00100000",
      event_at_utc: at,
      received_at_utc: at,
      sequence_num: sequence++,
      raw: {},
      normalized: { symbol: "SPY260611C00100000", bid: 1 + i * 0.03, ask: 1.08 + i * 0.03, bid_size: 20, ask_size: 25, delta: 0.58 },
      schema_version: 1,
    });
    events.push({
      event_id: `regime-underlying-${i}`,
      run_id: "fixture-regime",
      event_type: "underlying_bar",
      source: "fixture",
      symbol: "SPY",
      event_at_utc: at,
      received_at_utc: at,
      sequence_num: sequence++,
      raw: {},
      normalized: {
        symbol: "SPY",
        last_price: price,
        open: price - 0.06,
        high: price + 0.04,
        low: price - 0.08,
        close: price,
        bid: price - 0.01,
        ask: price + 0.01,
        vwap,
        volume: 100000 + i * 1000,
        opening_range_high: 100.4,
        opening_range_low: 99.6,
      },
      schema_version: 1,
    });
  }
  return events;
}
