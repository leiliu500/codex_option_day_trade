import { createHash } from "node:crypto";
import type { AppConfig } from "../config/config";
import type { ContractCandidate, PositionState, Signal, TradeAction } from "../domain/types";
import { optionMid } from "../domain/types";
import { etDateKey } from "../util/time";

export class ExecutionPolicy {
  private sequence = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly runId: string,
  ) {}

  buildOpenAction(signal: Signal, candidate: ContractCandidate, nowIso: string): TradeAction {
    const qty = 1;
    const mid = optionMid(candidate.quote);
    if (mid === undefined) {
      throw new Error(`Cannot build order intent without valid mid for ${candidate.contract.symbol}`);
    }
    const actionType = signal.direction === "bullish" ? "long_call" : "long_put";
    const actionId = this.nextActionId(signal.underlying_symbol, "open");
    return {
      action_id: actionId,
      client_order_id: this.clientOrderId(signal.underlying_symbol, "open", nowIso),
      action_type: "open",
      strategy_type: actionType,
      underlying_symbol: signal.underlying_symbol,
      legs: [
        {
          symbol: candidate.contract.symbol,
          side: "buy",
          ratio_qty: 1,
          position_intent: "buy_to_open",
        },
      ],
      qty,
      order_type: "limit",
      limit_price: roundCents(mid),
      time_in_force: "day",
      max_loss_dollars: roundCents(mid * 100 * qty),
      entry_reason: signal.reason_codes,
      exit_reason: [],
      created_at_utc: nowIso,
    };
  }

  buildCloseAction(position: PositionState, reason: string, nowIso: string, limitPrice?: number): TradeAction {
    const actionId = this.nextActionId(position.underlying_symbol, "close");
    return {
      action_id: actionId,
      client_order_id: this.clientOrderId(position.underlying_symbol, "close", nowIso),
      action_type: "close",
      strategy_type: position.strategy_type,
      underlying_symbol: position.underlying_symbol,
      legs: [
        {
          symbol: position.symbol,
          side: "sell",
          ratio_qty: 1,
          position_intent: "sell_to_close",
        },
      ],
      qty: Math.max(1, Math.round(position.qty)),
      order_type: "limit",
      limit_price: limitPrice === undefined ? undefined : roundCents(limitPrice),
      time_in_force: "day",
      max_loss_dollars: 0,
      entry_reason: [],
      exit_reason: [reason],
      created_at_utc: nowIso,
    };
  }

  private nextActionId(underlying: string, actionType: "open" | "close"): string {
    this.sequence += 1;
    return createHash("sha1").update([this.runId, underlying, actionType, this.sequence].join("|")).digest("hex");
  }

  private clientOrderId(underlying: string, actionType: "open" | "close", nowIso: string): string {
    const date = etDateKey(new Date(nowIso), this.config.system.timezone).replaceAll("-", "");
    return `${this.config.execution.client_order_id_prefix}-${date}-${underlying}-${actionType}-${this.sequence
      .toString()
      .padStart(6, "0")}`;
  }
}

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
