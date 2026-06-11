import type { EventEnvelope } from "../domain/types";
import type { LiveState } from "../domain/state";

export interface ReplayReport {
  source_run_id?: string;
  replay_id: string;
  config_hash: string;
  events_processed: number;
  decisions_generated: number;
  orders_simulated: number;
  fills_simulated: number;
  blocked_decisions: number;
  mismatches: string[];
  pnl_simulated: string;
  max_drawdown_simulated: string;
}

export function buildReplayReport(params: {
  replayId: string;
  configHash: string;
  inputEvents: EventEnvelope[];
  outputEvents: EventEnvelope[];
  state: LiveState;
  mismatches?: string[];
}): ReplayReport {
  return {
    source_run_id: params.inputEvents[0]?.run_id,
    replay_id: params.replayId,
    config_hash: params.configHash,
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
  };
}
