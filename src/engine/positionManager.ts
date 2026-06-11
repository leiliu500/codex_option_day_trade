import type { AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import type { PositionState, TradeAction } from "../domain/types";
import { optionMid } from "../domain/types";
import { isEtAtOrAfter, secondsBetweenIso } from "../util/time";
import { ExecutionPolicy } from "./executionPolicy";

export class PositionManager {
  constructor(
    private readonly config: AppConfig,
    private readonly executionPolicy: ExecutionPolicy,
  ) {}

  evaluateExits(state: LiveState, nowIso: string): TradeAction[] {
    state.markPositionsToMarket();
    const actions: TradeAction[] = [];
    for (const position of state.getOpenPositions()) {
      if (position.status !== "open" || hasClosingOrder(state, position.symbol)) {
        continue;
      }
      const reason = this.exitReason(position, nowIso);
      if (!reason) {
        continue;
      }
      const quote = state.optionQuotes.get(position.symbol);
      actions.push(this.executionPolicy.buildCloseAction(position, reason, nowIso, optionMid(quote)));
    }
    return actions;
  }

  private exitReason(position: PositionState, nowIso: string): string | undefined {
    const mark = position.last_mark_price;
    if (this.config.exit.force_flatten_before_close && isEtAtOrAfter(new Date(nowIso), this.config.session.force_flatten_time_et, this.config.system.timezone)) {
      return "force_flatten";
    }
    if (mark !== undefined && position.stop_loss_price !== undefined && mark <= position.stop_loss_price) {
      return "stop_loss";
    }
    if (mark !== undefined && position.take_profit_price !== undefined && mark >= position.take_profit_price) {
      return "take_profit";
    }
    const ageMinutes = secondsBetweenIso(position.opened_at_utc, nowIso) / 60;
    if (ageMinutes >= this.config.exit.time_stop_minutes && (position.unrealized_pnl ?? 0) <= 0) {
      return "time_stop";
    }
    return undefined;
  }
}

function hasClosingOrder(state: LiveState, symbol: string): boolean {
  return state.getOpenOrders().some((order) => order.symbol === symbol && order.position_intent === "sell_to_close");
}
