import { randomUUID } from "node:crypto";
import { isRiskLimitEnabled, type AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import type { OptionContract, RiskDecision, StrategyType, TradeAction } from "../domain/types";
import { optionMid } from "../domain/types";
import { isEtAtOrAfter, isEtBetween, secondsBetweenIso } from "../util/time";

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
    const legStates = action.legs.map((item) => ({
      leg: item,
      quote: state.optionQuotes.get(item.symbol),
      contract: state.contracts.get(item.symbol),
    }));
    const quote = state.optionQuotes.get(leg.symbol);
    const mid = optionMid(quote);
    const spreadPcts = legStates
      .map((item) => {
        const itemMid = optionMid(item.quote);
        const itemSpread = item.quote?.bid !== undefined && item.quote.ask !== undefined ? item.quote.ask - item.quote.bid : undefined;
        return itemMid !== undefined && itemSpread !== undefined ? itemSpread / itemMid : undefined;
      })
      .filter((value): value is number => value !== undefined);
    const spreadPct = spreadPcts.length === 0 ? undefined : Math.max(...spreadPcts);
    const quoteAges = legStates.map((item) => secondsBetweenIso(item.quote?.received_at_utc, nowIso));
    const quoteAge = quoteAges.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...quoteAges);
    const underlying = state.underlyings.get(action.underlying_symbol);
    const underlyingAge = secondsBetweenIso(underlying?.last_received_at_utc, nowIso);

    rules.option_quote_age_seconds = quoteAge;
    rules.underlying_quote_age_seconds = underlyingAge;
    rules.spread_pct_of_mid = spreadPct;
    rules.leg_count = action.legs.length;
    rules.order_class = action.order_class ?? (action.legs.length > 1 ? "mleg" : "simple");
    rules.strategy_type = action.strategy_type;
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
      if (
        action.legs.some((leg) => leg.position_intent === "sell_to_open") &&
        !this.config.option_strategy.allow_naked_short_options &&
        !definedRiskShortOpenLegs(action, legStates.map((item) => item.contract))
      ) {
        blocked.push("naked_or_short_option_not_allowed");
      }
      if (action.legs.some((leg) => leg.position_intent === "buy_to_close")) {
        blocked.push("buy_to_close_not_allowed_for_open_action");
      }
      if (action.legs.length > 1 && this.config.option_strategy.options_approval_level < this.config.option_strategy.options_level_required_for_mleg) {
        blocked.push("options_level_insufficient_for_mleg");
      }
      if (!strategyEnabled(action.strategy_type, this.config)) {
        blocked.push("strategy_disabled");
      }
      if (action.legs.length > 1 && !sameUnderlyingAndExpiration(legStates.map((item) => item.contract))) {
        blocked.push("multi_leg_contract_mismatch");
      }
      if (isCreditStrategy(action.strategy_type) && action.entry_reason.includes("regime_HIGH_VOL_WHIPSAW")) {
        blocked.push("credit_strategy_blocked_in_high_vol_whipsaw");
      }
      if (
        isCreditStrategy(action.strategy_type) &&
        isEtAtOrAfter(new Date(nowIso), this.config.option_strategy.last_credit_spread_entry_time_et, this.config.system.timezone)
      ) {
        blocked.push("too_late_for_credit_spread_entry");
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
      if (
        legStates.some((item) => {
          const itemMid = optionMid(item.quote);
          return !item.quote || item.quote.bid === undefined || item.quote.ask === undefined || item.quote.bid <= 0 || item.quote.ask <= item.quote.bid || itemMid === undefined;
        })
      ) {
        blocked.push("bid_ask_invalid");
      }
      if (quoteAge > this.config.stream.max_quote_age_seconds) {
        blocked.push("option_quote_stale");
      }
      if (spreadPct !== undefined && spreadPct > this.config.contract_selector.max_spread_pct_of_mid) {
        blocked.push("spread_too_wide");
      }
    }
    if (legStates.some((item) => item.contract?.status && item.contract.status !== "active")) {
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

function strategyEnabled(strategy: StrategyType | undefined, config: AppConfig): boolean {
  switch (strategy) {
    case "call_debit_spread":
    case "put_debit_spread":
      return config.option_strategy.enable_debit_spreads;
    case "put_credit_spread":
    case "call_credit_spread":
      return config.option_strategy.enable_credit_spreads;
    case "iron_condor":
      return config.option_strategy.enable_iron_condor;
    case "long_straddle":
    case "long_strangle":
      return config.option_strategy.enable_long_straddles;
    default:
      return true;
  }
}

function isCreditStrategy(strategy: StrategyType | undefined): boolean {
  return strategy === "put_credit_spread" || strategy === "call_credit_spread" || strategy === "iron_condor";
}

function sameUnderlyingAndExpiration(contracts: Array<OptionContract | undefined>): boolean {
  if (contracts.some((contract) => contract === undefined)) {
    return false;
  }
  const defined = contracts as OptionContract[];
  if (defined.length <= 1) {
    return true;
  }
  return defined.every(
    (contract) =>
      contract.underlying_symbol === defined[0].underlying_symbol && contract.expiration_date === defined[0].expiration_date,
  );
}

function definedRiskShortOpenLegs(action: TradeAction, contracts: Array<OptionContract | undefined>): boolean {
  const bySymbol = new Map<string, OptionContract>();
  for (const contract of contracts) {
    if (contract) {
      bySymbol.set(contract.symbol, contract);
    }
  }
  const shortOpenLegs = action.legs.filter((leg) => leg.position_intent === "sell_to_open");
  if (shortOpenLegs.length === 0) {
    return true;
  }
  return shortOpenLegs.every((shortLeg) => {
    const shortContract = bySymbol.get(shortLeg.symbol);
    if (!shortContract) {
      return false;
    }
    return action.legs.some((longLeg) => {
      if (longLeg.position_intent !== "buy_to_open" || longLeg.symbol === shortLeg.symbol) {
        return false;
      }
      const longContract = bySymbol.get(longLeg.symbol);
      return (
        longContract !== undefined &&
        longContract.underlying_symbol === shortContract.underlying_symbol &&
        longContract.expiration_date === shortContract.expiration_date &&
        longContract.right === shortContract.right &&
        longContract.strike_price !== shortContract.strike_price
      );
    });
  });
}
