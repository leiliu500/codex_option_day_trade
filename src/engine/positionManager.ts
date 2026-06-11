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
      const reason = this.exitReason(position, state, nowIso);
      if (!reason) {
        continue;
      }
      const quote = state.optionQuotes.get(position.symbol);
      actions.push(
        this.executionPolicy.buildCloseAction(
          position,
          reason,
          nowIso,
          quote?.bid ?? optionMid(quote) ?? position.last_mark_price ?? position.avg_entry_price,
        ),
      );
    }
    return actions;
  }

  private exitReason(position: PositionState, state: LiveState, nowIso: string): string | undefined {
    const mark = position.last_mark_price;
    if (this.config.exit.force_flatten_before_close && isEtAtOrAfter(new Date(nowIso), this.config.session.force_flatten_time_et, this.config.system.timezone)) {
      return "force_flatten";
    }
    const protectiveStop = this.protectiveStop(position);
    if (mark !== undefined && protectiveStop !== undefined && mark <= protectiveStop.price) {
      if (
        protectiveStop.reason === "stop_loss" &&
        this.config.exit.defer_loss_exits_while_underlying_trend_valid &&
        this.underlyingTrendStillValid(position, state, nowIso)
      ) {
        return undefined;
      }
      return protectiveStop.reason;
    }
    if (mark !== undefined && position.take_profit_price !== undefined && mark >= position.take_profit_price) {
      return "take_profit";
    }
    if (this.config.exit.exit_on_signal_reversal && this.underlyingReversed(position, state, nowIso)) {
      return "signal_reversal";
    }
    const ageMinutes = secondsBetweenIso(position.opened_at_utc, nowIso) / 60;
    if (ageMinutes >= this.config.exit.time_stop_minutes && (position.unrealized_pnl ?? 0) <= 0) {
      if (
        this.config.exit.defer_loss_exits_while_underlying_trend_valid &&
        this.underlyingTrendStillValid(position, state, nowIso)
      ) {
        return undefined;
      }
      return "time_stop";
    }
    return undefined;
  }

  private protectiveStop(position: PositionState): { price: number; reason: string } | undefined {
    let price = position.stop_loss_price;
    let reason = "stop_loss";
    const highest = position.highest_mark_price ?? position.last_mark_price;
    if (highest !== undefined && highest >= position.avg_entry_price * (1 + this.config.exit.breakeven_trigger_pct)) {
      price = Math.max(price ?? 0, position.avg_entry_price);
      reason = "breakeven_stop";
    }
    if (highest !== undefined && highest >= position.avg_entry_price * (1 + this.config.exit.trailing_stop_activation_pct)) {
      const trailingPrice = highest * (1 - this.config.exit.trailing_stop_pct);
      if (price === undefined || trailingPrice > price) {
        price = trailingPrice;
        reason = "trailing_stop";
      }
    }
    return price === undefined ? undefined : { price, reason };
  }

  private underlyingReversed(position: PositionState, state: LiveState, nowIso: string): boolean {
    const underlying = state.underlyings.get(position.underlying_symbol);
    if (
      underlying?.last_price === undefined ||
      underlying.opening_range_high === undefined ||
      underlying.opening_range_low === undefined
    ) {
      return false;
    }
    const momentum = state.getMomentumBps(
      position.underlying_symbol,
      nowIso,
      Math.max(30, this.config.strategy.opening_range_minutes * 60),
    );
    if (position.strategy_type === "long_call") {
      return underlying.last_price < underlying.opening_range_low && momentum <= -this.config.strategy.min_underlying_momentum_bps;
    }
    if (position.strategy_type === "long_put") {
      return underlying.last_price > underlying.opening_range_high && momentum >= this.config.strategy.min_underlying_momentum_bps;
    }
    return false;
  }

  private underlyingTrendStillValid(position: PositionState, state: LiveState, nowIso: string): boolean {
    const underlying = state.underlyings.get(position.underlying_symbol);
    if (
      underlying?.last_price === undefined ||
      underlying.vwap === undefined ||
      underlying.opening_range_high === undefined ||
      underlying.opening_range_low === undefined
    ) {
      return false;
    }
    const momentum = state.getMomentumBps(
      position.underlying_symbol,
      nowIso,
      Math.max(30, this.config.strategy.opening_range_minutes * 60),
    );
    if (position.strategy_type === "long_call") {
      return (
        underlying.last_price > underlying.vwap &&
        underlying.last_price > underlying.opening_range_high &&
        momentum >= 0
      );
    }
    if (position.strategy_type === "long_put") {
      return (
        underlying.last_price < underlying.vwap &&
        underlying.last_price < underlying.opening_range_low &&
        momentum <= 0
      );
    }
    return false;
  }
}

function hasClosingOrder(state: LiveState, symbol: string): boolean {
  return state.getOpenOrders().some((order) => order.symbol === symbol && order.position_intent === "sell_to_close");
}
