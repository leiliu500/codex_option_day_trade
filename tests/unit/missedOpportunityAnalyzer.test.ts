import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMissedOpportunities } from "../../src/replay/missedOpportunityAnalyzer";
import type { EventEnvelope } from "../../src/domain/types";

test("missed opportunity analyzer labels blocked winning option candidates", () => {
  const inputEvents: EventEnvelope[] = [
    optionQuote("q0", "2026-06-11T14:00:00.000Z", 1, 1.1),
    optionQuote("q1", "2026-06-11T14:01:00.000Z", 1.3, 1.4),
    optionQuote("q2", "2026-06-11T14:02:00.000Z", 1.2, 1.3),
  ];
  const outputEvents: EventEnvelope[] = [
    {
      event_id: "decision-1",
      run_id: "test",
      event_type: "decision_blocked",
      source: "strategy",
      symbol: "SPY",
      received_at_utc: "2026-06-11T14:00:00.000Z",
      sequence_num: 1,
      raw: {},
      normalized: {
        selected_contract: "SPY260611C00100000",
        risk_decision: { blocked_reasons: ["max_open_positions_reached"] },
        candidate: {
          timestamp: "2026-06-11T14:00:00.000Z",
          underlying: "SPY",
          direction: "BULLISH",
          regime: "GRIND_UP",
          setupType: "VWAP_PULLBACK",
          score: 82,
          targetBps: 1500,
          stopBps: 1000,
          maxHoldSeconds: 300,
          triggerPrice: 100,
        },
      },
      schema_version: 1,
    },
  ];

  const report = analyzeMissedOpportunities({ inputEvents, outputEvents });

  assert.equal(report.labels.length, 1);
  assert.equal(report.labels[0].wouldHaveWon, true);
  assert.equal(report.labels[0].firstBlocker, "risk_gate_blocked");
  assert.deepEqual(report.labels[0].rawBlockers, ["max_open_positions_reached"]);
  assert.ok(report.labels[0].mfePct > 0.2);
  assert.equal(report.by_regime_setup[0].missed_winning_count, 1);
});

test("missed opportunity analyzer reports canonical miss reasons", () => {
  const inputEvents: EventEnvelope[] = [
    optionQuote("q0", "2026-06-11T14:00:00.000Z", 1, 1.1),
    optionQuote("q1", "2026-06-11T14:01:00.000Z", 1.3, 1.4),
  ];
  const outputEvents: EventEnvelope[] = [
    {
      event_id: "decision-canonical",
      run_id: "test",
      event_type: "decision_blocked",
      source: "strategy",
      symbol: "SPY",
      received_at_utc: "2026-06-11T14:00:00.000Z",
      sequence_num: 1,
      raw: {},
      normalized: {
        selected_contract: "SPY260611C00100000",
        reason_codes: [
          "outside_entry_window",
          "opening_range_too_wide",
          "score_too_low",
          "slope_too_low",
          "acceleration_too_low",
          "entry_setup_not_fresh",
          "no_contract_candidate",
        ],
        risk_decision: { approved: false, blocked_reasons: ["spread_too_wide"] },
        strategy_decision: {
          noTradeReason: "strategy_score_too_low",
          candidates: [
            {
              strategy: "CALL_DEBIT_SPREAD",
              blockers: ["spread_debit_too_high", "credit_spreads_disabled"],
            },
          ],
        },
        candidate: {
          timestamp: "2026-06-11T14:00:00.000Z",
          underlying: "SPY",
          direction: "BULLISH",
          regime: "STRONG_UP",
          setupType: "ORB_CONTINUATION",
          score: 60,
          blockers: ["score_too_low", "slope_too_low", "acceleration_too_low"],
          targetBps: 1500,
          stopBps: 1000,
          maxHoldSeconds: 300,
          triggerPrice: 100,
        },
      },
      schema_version: 1,
    },
  ];

  const report = analyzeMissedOpportunities({ inputEvents, outputEvents });

  assert.deepEqual(report.labels[0].allBlockers, [
    "spread_too_wide",
    "score_too_low",
    "slope_too_low",
    "acceleration_too_low",
    "strategy_score_too_low",
    "spread_construction_failed",
    "strategy_policy_blocked",
    "entry_window_blocked",
    "opening_range_too_wide",
    "cooldown_blocked",
    "contract_not_found",
    "risk_gate_blocked",
  ]);
});

function optionQuote(eventId: string, at: string, bid: number, ask: number): EventEnvelope {
  return {
    event_id: eventId,
    run_id: "fixture",
    event_type: "option_quote",
    source: "fixture",
    symbol: "SPY260611C00100000",
    event_at_utc: at,
    received_at_utc: at,
    sequence_num: 1,
    raw: {},
    normalized: {
      symbol: "SPY260611C00100000",
      bid,
      ask,
    },
    schema_version: 1,
  };
}
