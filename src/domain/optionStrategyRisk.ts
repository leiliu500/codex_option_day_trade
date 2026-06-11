import type { AppConfig } from "../config/config";
import { MarketRegime } from "./regimeTypes";
import type { OptionContract } from "./types";
import type { OptionOrderPlan, StrategyCandidate, StrategyType } from "../types/optionStrategy";
import { secondsSinceMidnightInZone, secondsFromClock } from "../util/time";

export interface StrategyRiskResult {
  maxLossDollars: number | null;
  maxProfitDollars?: number | null;
  blockers: string[];
}

export interface RiskContext {
  config: AppConfig;
  marketRegime: MarketRegime;
  nowIso: string;
}

export function longOptionRisk(debit: number, qty = 1): StrategyRiskResult {
  return {
    maxLossDollars: roundDollars(debit * 100 * qty),
    maxProfitDollars: null,
    blockers: debit > 0 ? [] : ["missing_debit"],
  };
}

export function debitSpreadRisk(netDebit: number, spreadWidth: number, qty = 1): StrategyRiskResult {
  return {
    maxLossDollars: roundDollars(netDebit * 100 * qty),
    maxProfitDollars: roundDollars(Math.max(0, spreadWidth - netDebit) * 100 * qty),
    blockers: [...(netDebit > 0 ? [] : ["missing_net_debit"]), ...(spreadWidth > 0 ? [] : ["missing_spread_width"])],
  };
}

export function creditSpreadRisk(netCredit: number, spreadWidth: number, qty = 1): StrategyRiskResult {
  return {
    maxLossDollars: roundDollars(Math.max(0, spreadWidth - netCredit) * 100 * qty),
    maxProfitDollars: roundDollars(netCredit * 100 * qty),
    blockers: [...(netCredit > 0 ? [] : ["missing_net_credit"]), ...(spreadWidth > 0 ? [] : ["missing_spread_width"])],
  };
}

export function ironCondorRisk(netCredit: number, callSpreadWidth: number, putSpreadWidth: number, qty = 1): StrategyRiskResult {
  const maxWidth = Math.max(callSpreadWidth, putSpreadWidth);
  return {
    maxLossDollars: roundDollars(Math.max(0, maxWidth - netCredit) * 100 * qty),
    maxProfitDollars: roundDollars(netCredit * 100 * qty),
    blockers: [
      ...(netCredit > 0 ? [] : ["missing_net_credit"]),
      ...(callSpreadWidth > 0 ? [] : ["missing_call_spread_width"]),
      ...(putSpreadWidth > 0 ? [] : ["missing_put_spread_width"]),
    ],
  };
}

export function strategyRiskBlockers(strategy: StrategyCandidate | OptionOrderPlan, ctx: RiskContext): string[] {
  const blockers = new Set<string>();
  const strategyType = "strategy" in strategy ? strategy.strategy : "NO_TRADE";
  const maxLoss = "maxLossDollarsEstimate" in strategy ? strategy.maxLossDollarsEstimate : strategy.maxLossDollars;

  if (strategyType === "NO_TRADE") {
    blockers.add("no_strategy");
  }
  if (containsNakedShortLeg(strategy)) {
    blockers.add("naked_short_leg_forbidden");
  }
  if (maxLoss == null || !Number.isFinite(maxLoss)) {
    blockers.add("missing_max_loss_estimate");
  }
  const strategyMaxLoss = ctx.config.option_strategy.max_loss_per_trade_dollars;
  if (maxLoss != null && strategyMaxLoss != null && maxLoss > strategyMaxLoss) {
    blockers.add("strategy_max_loss_exceeds_limit");
  }
  if (isCreditStrategy(strategyType) && !ctx.config.option_strategy.enable_credit_spreads) {
    blockers.add("credit_spreads_disabled");
  }
  if (strategyType === "IRON_CONDOR" && !ctx.config.option_strategy.enable_iron_condor) {
    blockers.add("iron_condor_disabled");
  }
  if (ctx.marketRegime === MarketRegime.HIGH_VOL_WHIPSAW && isCreditStrategy(strategyType)) {
    blockers.add("credit_strategy_blocked_in_high_vol_whipsaw");
  }
  if (isCreditStrategy(strategyType) && isEtAtOrAfter(ctx.nowIso, ctx.config.option_strategy.last_credit_spread_entry_time_et, ctx.config)) {
    blockers.add("too_late_for_credit_spread_entry");
  }

  return [...blockers];
}

export function containsNakedShortLeg(strategy: StrategyCandidate | OptionOrderPlan): boolean {
  const legs = strategy.legs;
  const shortOpenLegs = legs.filter((leg) => leg.positionIntent === "sell_to_open");
  if (shortOpenLegs.length === 0) {
    return false;
  }
  if (shortOpenLegs.length >= legs.length) {
    return true;
  }
  return shortOpenLegs.some((shortLeg) => !legs.some((leg) => leg.positionIntent === "buy_to_open" && leg.symbol !== shortLeg.symbol));
}

export function isCreditStrategy(strategy: StrategyType): boolean {
  return strategy === "PUT_CREDIT_SPREAD" || strategy === "CALL_CREDIT_SPREAD" || strategy === "IRON_CONDOR";
}

export function isDebitSpread(strategy: StrategyType): boolean {
  return strategy === "CALL_DEBIT_SPREAD" || strategy === "PUT_DEBIT_SPREAD";
}

export function allLegsSameUnderlyingAndExpiration(contracts: OptionContract[]): boolean {
  if (contracts.length <= 1) {
    return true;
  }
  const underlying = contracts[0].underlying_symbol;
  const expiration = contracts[0].expiration_date;
  return contracts.every((contract) => contract.underlying_symbol === underlying && contract.expiration_date === expiration);
}

function isEtAtOrAfter(nowIso: string, clockEt: string, config: AppConfig): boolean {
  return secondsSinceMidnightInZone(new Date(nowIso), config.system.timezone) >= secondsFromClock(clockEt);
}

function roundDollars(value: number): number {
  return Math.round(value * 100) / 100;
}
