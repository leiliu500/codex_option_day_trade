import { createHash } from "node:crypto";
import type { AppConfig } from "../config/config";
import type { Signal } from "./types";
import type { StrategyCandidate, StrategyType as OptionStrategyType, OptionOrderPlan } from "../types/optionStrategy";
import type { StrategyType as TradeStrategyType, TradeAction } from "./types";
import { etDateKey } from "../util/time";

export class StrategyActionBuilder {
  private sequence = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly runId: string,
  ) {}

  buildOpenAction(signal: Signal, selected: StrategyCandidate, nowIso: string): TradeAction {
    const plan = this.buildOrderPlan(selected);
    const actionId = this.nextActionId(signal.underlying_symbol, "open");
    return {
      action_id: actionId,
      client_order_id: this.clientOrderId(signal.underlying_symbol, "open", nowIso),
      action_type: "open",
      strategy_type: toTradeStrategyType(selected.strategy),
      underlying_symbol: signal.underlying_symbol,
      legs: plan.legs.map((leg) => ({
        symbol: leg.symbol,
        side: leg.side,
        ratio_qty: leg.ratioQty,
        position_intent: leg.positionIntent,
      })),
      qty: plan.qty,
      order_class: plan.orderClass,
      order_type: "limit",
      limit_price: roundCents(plan.netLimitPrice),
      debit_or_credit: plan.debitOrCredit,
      time_in_force: "day",
      max_loss_dollars: roundCents(plan.maxLossDollars),
      ...(plan.maxProfitDollars === undefined ? {} : { max_profit_dollars: roundCents(plan.maxProfitDollars) }),
      entry_reason: [...signal.reason_codes, ...selected.reasons, `strategy_${selected.strategy}`],
      exit_reason: [],
      created_at_utc: nowIso,
    };
  }

  buildOrderPlan(selected: StrategyCandidate): OptionOrderPlan {
    if (!selected.orderClass || !selected.debitOrCredit || selected.expectedDebitOrCredit === null || selected.maxLossDollarsEstimate === null) {
      throw new Error(`Cannot build option order plan for incomplete strategy candidate ${selected.strategy}`);
    }
    return {
      strategy: selected.strategy,
      orderClass: selected.orderClass,
      qty: 1,
      netLimitPrice: selected.expectedDebitOrCredit,
      debitOrCredit: selected.debitOrCredit,
      timeInForce: "day",
      legs: selected.legs,
      maxLossDollars: selected.maxLossDollarsEstimate,
      ...(selected.maxProfitDollarsEstimate === undefined || selected.maxProfitDollarsEstimate === null
        ? {}
        : { maxProfitDollars: selected.maxProfitDollarsEstimate }),
      entryReason: selected.reasons.join(","),
      blockers: selected.blockers,
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

export function toTradeStrategyType(strategy: OptionStrategyType): TradeStrategyType {
  switch (strategy) {
    case "LONG_CALL":
      return "long_call";
    case "LONG_PUT":
      return "long_put";
    case "CALL_DEBIT_SPREAD":
      return "call_debit_spread";
    case "PUT_DEBIT_SPREAD":
      return "put_debit_spread";
    case "PUT_CREDIT_SPREAD":
      return "put_credit_spread";
    case "CALL_CREDIT_SPREAD":
      return "call_credit_spread";
    case "IRON_CONDOR":
      return "iron_condor";
    case "LONG_STRADDLE":
      return "long_straddle";
    case "LONG_STRANGLE":
      return "long_strangle";
    default:
      throw new Error(`Strategy ${strategy} is not executable by the option day-trade engine.`);
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}
