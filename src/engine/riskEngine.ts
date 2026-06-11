import { randomUUID } from "node:crypto";
import { isRiskLimitEnabled, type AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import type { RiskDecision, TradeAction } from "../domain/types";
import { optionMid } from "../domain/types";
import { isEtBetween, secondsBetweenIso } from "../util/time";

export class RiskEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly configHash: string,
  ) {}

  evaluate(action: TradeAction, state: LiveState, nowIso: string, activeConfigHash: string = this.configHash): RiskDecision {
    const blocked: string[] = [];
    const rules: Record<string, unknown> = {
      action_type: action.action_type,
      config_hash_expected: this.configHash,
      config_hash_active: activeConfigHash,
    };
    const isClose = action.action_type === "close";
    const leg = action.legs[0];
    const quote = state.optionQuotes.get(leg.symbol);
    const mid = optionMid(quote);
    const spread = quote?.bid !== undefined && quote.ask !== undefined ? quote.ask - quote.bid : undefined;
    const spreadPct = mid !== undefined && spread !== undefined ? spread / mid : undefined;
    const quoteAge = secondsBetweenIso(quote?.received_at_utc, nowIso);
    const underlying = state.underlyings.get(action.underlying_symbol);
    const underlyingAge = secondsBetweenIso(underlying?.last_received_at_utc, nowIso);

    rules.option_quote_age_seconds = quoteAge;
    rules.underlying_quote_age_seconds = underlyingAge;
    rules.spread_pct_of_mid = spreadPct;
    rules.open_positions = state.getOpenPositions().length;
    rules.open_orders = state.getOpenOrders().length;
    rules.daily_realized_pnl = state.dailyRealizedPnl;
    rules.trades_today = state.tradesToday;
    rules.recent_rejects = state.recentRejects;

    if (activeConfigHash !== this.configHash) {
      blocked.push("config_hash_changed");
    }
    if (state.killSwitchEnabled) {
      blocked.push("kill_switch_enabled");
    }
    if (!isClose) {
      if (state.newEntriesDisabled) {
        blocked.push("new_entries_disabled");
      }
      if (action.legs.some((leg) => leg.position_intent === "sell_to_open" || leg.position_intent === "buy_to_close")) {
        blocked.push("naked_or_short_option_not_allowed");
      }
      if (!isEtBetween(new Date(nowIso), this.config.session.regular_open_et, this.config.session.regular_close_et, this.config.system.timezone)) {
        blocked.push("market_closed");
      }
      if (!isEtBetween(new Date(nowIso), this.config.session.first_entry_time_et, this.config.session.last_entry_time_et, this.config.system.timezone)) {
        blocked.push("outside_entry_window");
      }
      if (
        this.config.risk.block_new_entries_after_daily_loss &&
        isRiskLimitEnabled(this.config.risk.max_daily_loss_dollars) &&
        state.dailyRealizedPnl <= -this.config.risk.max_daily_loss_dollars
      ) {
        blocked.push("daily_max_loss_breached");
      }
      if (
        isRiskLimitEnabled(this.config.risk.max_open_positions) &&
        state.getOpenPositions().length >= this.config.risk.max_open_positions
      ) {
        blocked.push("max_open_positions_reached");
      }
      if (
        isRiskLimitEnabled(this.config.risk.max_open_orders) &&
        state.getOpenOrders().length >= this.config.risk.max_open_orders
      ) {
        blocked.push("max_open_orders_reached");
      }
      if (
        isRiskLimitEnabled(this.config.risk.max_trades_per_day) &&
        state.tradesToday >= this.config.risk.max_trades_per_day
      ) {
        blocked.push("max_trades_per_day_reached");
      }
      this.evaluateRequiredStreams(state, nowIso, blocked, rules);
      if (underlyingAge > this.config.stream.max_quote_age_seconds) {
        blocked.push("underlying_quote_stale");
      }
      if (
        this.config.risk.block_if_broker_reconciliation_mismatch &&
        state.brokerReconciliationMismatch
      ) {
        blocked.push("broker_reconciliation_mismatch");
      }
      if (state.recentRejects >= this.config.risk.block_new_entries_after_rejects) {
        blocked.push("recent_order_reject_threshold_reached");
      }
    }

    if (isClose) {
      if (action.limit_price === undefined || action.limit_price <= 0) {
        blocked.push("close_price_missing");
      }
    } else {
      if (!quote || quote.bid === undefined || quote.ask === undefined || quote.bid <= 0 || quote.ask <= quote.bid || mid === undefined) {
        blocked.push("bid_ask_invalid");
      }
      if (quoteAge > this.config.stream.max_quote_age_seconds) {
        blocked.push("option_quote_stale");
      }
      if (spreadPct !== undefined && spreadPct > this.config.contract_selector.max_spread_pct_of_mid) {
        blocked.push("spread_too_wide");
      }
    }
    const contract = state.contracts.get(leg.symbol);
    if (contract?.status && contract.status !== "active") {
      blocked.push("contract_not_active");
    }
    if (
      !isClose &&
      isRiskLimitEnabled(this.config.risk.max_loss_per_trade_dollars) &&
      action.max_loss_dollars > this.config.risk.max_loss_per_trade_dollars
    ) {
      blocked.push("max_loss_per_trade_exceeded");
    }
    if (
      !isClose &&
      isRiskLimitEnabled(this.config.risk.max_position_notional_dollars) &&
      action.max_loss_dollars > this.config.risk.max_position_notional_dollars
    ) {
      blocked.push("max_position_notional_exceeded");
    }

    const uniqueBlocked = [...new Set(blocked)];
    return {
      risk_decision_id: randomUUID(),
      action_id: action.action_id,
      status: uniqueBlocked.length === 0 ? "approved" : "blocked",
      approved: uniqueBlocked.length === 0,
      blocked_reasons: uniqueBlocked,
      evaluated_rules: rules,
      created_at_utc: nowIso,
    };
  }

  private evaluateRequiredStreams(
    state: LiveState,
    nowIso: string,
    blocked: string[],
    rules: Record<string, unknown>,
  ): void {
    if (!this.config.stream.no_new_entries_on_disconnect) {
      return;
    }
    const required = ["stock", "option", "trading"];
    const streamRules: Record<string, unknown> = {};
    for (const name of required) {
      const health = state.streamHealth.get(name);
      const lag = secondsBetweenIso(health?.last_message_at_utc, nowIso);
      streamRules[name] = {
        connected: health?.connected ?? false,
        authenticated: health?.authenticated ?? false,
        lag,
      };
      if (!health?.connected || !health.authenticated) {
        blocked.push(`stream_${name}_disconnected`);
      } else if (lag > this.config.stream.max_required_stream_lag_seconds) {
        blocked.push(`stream_${name}_stale`);
      }
    }
    rules.streams = streamRules;
  }
}
