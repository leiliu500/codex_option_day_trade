import { MarketRegime } from "./regimeTypes";
import type { StrategyPolicyInput, StrategyType } from "../types/optionStrategy";

export function allowedStrategies(input: StrategyPolicyInput): StrategyType[] {
  const level3 = input.optionsLevel >= 3;

  if (!input.hasLongStockPosition && input.direction !== "BULLISH" && input.direction !== "BEARISH" && input.direction !== "NEUTRAL") {
    return ["NO_TRADE"];
  }

  if (input.marketRegime === MarketRegime.HIGH_VOL_WHIPSAW) {
    if (input.direction === "BULLISH") {
      return level3 ? ["CALL_DEBIT_SPREAD"] : ["LONG_CALL"];
    }
    if (input.direction === "BEARISH") {
      return level3 ? ["PUT_DEBIT_SPREAD"] : ["LONG_PUT"];
    }
    return ["NO_TRADE"];
  }

  if (input.direction === "BULLISH") {
    return bullishStrategies(input, level3);
  }

  if (input.direction === "BEARISH") {
    return bearishStrategies(input, level3);
  }

  if (input.direction === "NEUTRAL") {
    if (
      input.volatilityRegime === "HIGH_IV" &&
      level3 &&
      input.enableIronCondor &&
      (input.marketRegime === MarketRegime.CHOP_DOJI || input.marketRegime === MarketRegime.COMPRESSION)
    ) {
      return ["IRON_CONDOR"];
    }
    if (
      input.volatilityRegime === "LOW_IV" &&
      level3 &&
      input.enableLongStraddles &&
      input.marketRegime === MarketRegime.COMPRESSION
    ) {
      return ["LONG_STRADDLE", "LONG_STRANGLE"];
    }
    return ["NO_TRADE"];
  }

  if (input.hasLongStockPosition) {
    return level3 ? ["PROTECTIVE_PUT", "COLLAR"] : ["PROTECTIVE_PUT"];
  }

  return ["NO_TRADE"];
}

function bullishStrategies(input: StrategyPolicyInput, level3: boolean): StrategyType[] {
  switch (input.volatilityRegime) {
    case "LOW_IV":
      return level3 ? ["LONG_CALL", "CALL_DEBIT_SPREAD"] : ["LONG_CALL"];
    case "NORMAL_IV":
      return level3 ? ["CALL_DEBIT_SPREAD", "LONG_CALL"] : ["LONG_CALL"];
    case "HIGH_IV": {
      const out: StrategyType[] = level3 ? ["CALL_DEBIT_SPREAD", "LONG_CALL"] : ["LONG_CALL"];
      if (level3 && input.enableCreditSpreads && stableBullishCreditRegime(input.marketRegime)) {
        out.push("PUT_CREDIT_SPREAD");
      }
      return out;
    }
    case "EXTREME_IV":
      return level3 ? ["CALL_DEBIT_SPREAD"] : ["NO_TRADE"];
    default:
      return level3 ? ["CALL_DEBIT_SPREAD", "LONG_CALL"] : ["LONG_CALL"];
  }
}

function bearishStrategies(input: StrategyPolicyInput, level3: boolean): StrategyType[] {
  switch (input.volatilityRegime) {
    case "LOW_IV":
      return level3 ? ["LONG_PUT", "PUT_DEBIT_SPREAD"] : ["LONG_PUT"];
    case "NORMAL_IV":
      return level3 ? ["PUT_DEBIT_SPREAD", "LONG_PUT"] : ["LONG_PUT"];
    case "HIGH_IV": {
      const out: StrategyType[] = level3 ? ["PUT_DEBIT_SPREAD", "LONG_PUT"] : ["LONG_PUT"];
      if (level3 && input.enableCreditSpreads && stableBearishCreditRegime(input.marketRegime)) {
        out.push("CALL_CREDIT_SPREAD");
      }
      return out;
    }
    case "EXTREME_IV":
      return level3 ? ["PUT_DEBIT_SPREAD"] : ["NO_TRADE"];
    default:
      return level3 ? ["PUT_DEBIT_SPREAD", "LONG_PUT"] : ["LONG_PUT"];
  }
}

function stableBullishCreditRegime(regime: MarketRegime): boolean {
  return regime === MarketRegime.GRIND_UP;
}

function stableBearishCreditRegime(regime: MarketRegime): boolean {
  return regime === MarketRegime.GRIND_DOWN;
}
