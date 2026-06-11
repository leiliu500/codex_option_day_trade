import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../src/config/config";
import type { EventEnvelope } from "../../src/domain/types";
import { sha256 } from "../../src/util/hash";
import { runEventsThroughProductionEngine, runReplayFromJsonl } from "../../src/replay/replayRunner";

test("bullish fixture produces deterministic approved order intent", async () => {
  const { config } = loadConfig("configs/paper.yaml");
  config.session.first_entry_time_et = "10:00:00";
  config.strategy.entry_confirmation_seconds = 0;
  config.strategy.max_opening_range_bps = null;
  const result = await runEventsThroughProductionEngine({
    inputEvents: loadFixture("tests/replay_fixtures/02_bullish_signal_risk_approved_order_submitted.jsonl"),
    config,
    configHash: sha256(config),
  });
  const report = result.report;
  assert.equal(report.events_processed, 10);
  assert.equal(report.orders_simulated, 1);
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
  const inputEvents = loadFixture("tests/replay_fixtures/02_bullish_signal_risk_approved_order_submitted.jsonl");
  inputEvents.push(
    ...["stock", "option", "trading"].map((name, index) => ({
      event_id: `fx-02-repeat-health-${name}`,
      run_id: "fixture-02",
      event_type: "stream_health",
      source: "fixture" as const,
      received_at_utc: "2026-06-11T14:00:59.000Z",
      sequence_num: 11 + index,
      raw: {},
      normalized: {
        name,
        connected: true,
        authenticated: true,
        last_message_at_utc: "2026-06-11T14:00:59.000Z",
        reconnect_count: 0,
        subscriptions: name === "stock" ? ["SPY"] : name === "option" ? ["SPY260611C00100000"] : ["trade_updates"],
      },
      schema_version: 1,
    })),
    {
      event_id: "fx-02-repeat-option-quote",
      run_id: "fixture-02",
      event_type: "option_quote",
      source: "fixture",
      symbol: "SPY260611C00100000",
      event_at_utc: "2026-06-11T14:00:59.000Z",
      received_at_utc: "2026-06-11T14:00:59.000Z",
      sequence_num: 14,
      raw: {},
      normalized: { symbol: "SPY260611C00100000", bid: 0.95, ask: 1.03, bid_size: 20, ask_size: 25, delta: 0.52 },
      schema_version: 1,
    },
    {
      event_id: "fx-02-repeat-underlying",
      run_id: "fixture-02",
      event_type: "underlying_quote",
      source: "fixture",
      symbol: "SPY",
      event_at_utc: "2026-06-11T14:01:00.000Z",
      received_at_utc: "2026-06-11T14:01:00.000Z",
      sequence_num: 15,
      raw: {},
      normalized: {
        symbol: "SPY",
        last_price: 101.05,
        bid: 101.04,
        ask: 101.06,
        vwap: 100,
        opening_range_high: 100.5,
        opening_range_low: 99.5,
      },
      schema_version: 1,
    },
  );

  const result = await runEventsThroughProductionEngine({ inputEvents, config, configHash: sha256(config) });

  assert.equal(result.report.orders_simulated, 1);
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
  const inputEvents = loadFixture("tests/replay_fixtures/02_bullish_signal_risk_approved_order_submitted.jsonl");
  inputEvents.push(...freshBullishConfirmationEvents());

  const result = await runEventsThroughProductionEngine({ inputEvents, config, configHash: sha256(config) });

  assert.equal(result.report.orders_simulated, 1);
  assert.ok(
    result.outputEvents.some((event) => {
      const reasons = event.normalized.reason_codes;
      return event.event_type === "decision_no_trade" && Array.isArray(reasons) && reasons.includes("entry_setup_waiting_for_confirmation");
    }),
  );
});

function loadFixture(path: string): EventEnvelope[] {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as EventEnvelope);
}

function freshBullishConfirmationEvents(): EventEnvelope[] {
  return [
    ...["stock", "option", "trading"].map((name, index) => ({
      event_id: `fx-02-confirm-health-${name}`,
      run_id: "fixture-02",
      event_type: "stream_health",
      source: "fixture" as const,
      received_at_utc: "2026-06-11T14:00:59.000Z",
      sequence_num: 11 + index,
      raw: {},
      normalized: {
        name,
        connected: true,
        authenticated: true,
        last_message_at_utc: "2026-06-11T14:00:59.000Z",
        reconnect_count: 0,
        subscriptions: name === "stock" ? ["SPY"] : name === "option" ? ["SPY260611C00100000"] : ["trade_updates"],
      },
      schema_version: 1,
    })),
    {
      event_id: "fx-02-confirm-option-quote",
      run_id: "fixture-02",
      event_type: "option_quote",
      source: "fixture",
      symbol: "SPY260611C00100000",
      event_at_utc: "2026-06-11T14:00:59.000Z",
      received_at_utc: "2026-06-11T14:00:59.000Z",
      sequence_num: 14,
      raw: {},
      normalized: { symbol: "SPY260611C00100000", bid: 0.95, ask: 1.03, bid_size: 20, ask_size: 25, delta: 0.52 },
      schema_version: 1,
    },
    {
      event_id: "fx-02-confirm-underlying",
      run_id: "fixture-02",
      event_type: "underlying_quote",
      source: "fixture",
      symbol: "SPY",
      event_at_utc: "2026-06-11T14:01:00.000Z",
      received_at_utc: "2026-06-11T14:01:00.000Z",
      sequence_num: 15,
      raw: {},
      normalized: {
        symbol: "SPY",
        last_price: 101.1,
        bid: 101.09,
        ask: 101.11,
        vwap: 100,
        opening_range_high: 100.5,
        opening_range_low: 99.5,
      },
      schema_version: 1,
    },
  ];
}
