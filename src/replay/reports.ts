import type { EventEnvelope } from "../domain/types";
import type { LiveState } from "../domain/state";
import { DEFAULT_TIMEZONE, formatZonedIso, nowUtcIso } from "../util/time";
import { analyzeMissedOpportunities, type OpportunityVerificationSummary } from "./missedOpportunityAnalyzer";

export interface ReplayReport {
  source_run_id?: string;
  replay_id: string;
  config_hash: string;
  timezone: string;
  generated_at_utc: string;
  generated_at_et: string;
  events_processed: number;
  decisions_generated: number;
  orders_simulated: number;
  fills_simulated: number;
  blocked_decisions: number;
  mismatches: string[];
  pnl_simulated: string;
  max_drawdown_simulated: string;
  opportunity_verification: OpportunityVerificationSummary;
}

export function buildReplayReport(params: {
  replayId: string;
  configHash: string;
  inputEvents: EventEnvelope[];
  outputEvents: EventEnvelope[];
  state: LiveState;
  mismatches?: string[];
  timezone?: string;
}): ReplayReport {
  const timezone = params.timezone ?? DEFAULT_TIMEZONE;
  const generatedAtUtc = nowUtcIso();
  return {
    source_run_id: params.inputEvents[0]?.run_id,
    replay_id: params.replayId,
    config_hash: params.configHash,
    timezone,
    generated_at_utc: generatedAtUtc,
    generated_at_et: formatZonedIso(generatedAtUtc, timezone),
    events_processed: params.inputEvents.length,
    decisions_generated: params.outputEvents.filter((event) => event.event_type.startsWith("decision_")).length,
    orders_simulated: params.outputEvents.filter((event) => event.event_type === "order_submitted").length,
    fills_simulated: params.outputEvents.filter(
      (event) => event.event_type === "trade_update" && event.normalized.status === "filled",
    ).length,
    blocked_decisions: params.outputEvents.filter(
      (event) => event.event_type === "risk_decision" && (event.normalized.risk_decision as { approved?: boolean }).approved === false,
    ).length,
    mismatches: params.mismatches ?? [],
    pnl_simulated: params.state.dailyRealizedPnl.toFixed(2),
    max_drawdown_simulated: "0.00",
    opportunity_verification: analyzeMissedOpportunities({
      inputEvents: params.inputEvents,
      outputEvents: params.outputEvents,
    }),
  };
}
