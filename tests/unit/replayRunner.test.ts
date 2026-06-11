import test from "node:test";
import assert from "node:assert/strict";
import { runReplayFromJsonl } from "../../src/replay/replayRunner";

test("bullish fixture produces deterministic approved order intent", async () => {
  const report = await runReplayFromJsonl({
    eventPath: "tests/replay_fixtures/02_bullish_signal_risk_approved_order_submitted.jsonl",
    configPath: "configs/paper.yaml",
  });
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
