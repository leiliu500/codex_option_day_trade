import type { AppConfig } from "../config/config";
import type { LiveState } from "./state";
import { MarketRegime } from "./regimeTypes";
import type { SignalCandidate } from "./signalTypes";
import type { ContractCandidate, OptionContract, OptionQuoteState, OptionRight } from "./types";
import { optionMid } from "./types";
import { allowedStrategies } from "./strategyPolicyEngine";
import {
  creditSpreadRisk,
  debitSpreadRisk,
  ironCondorRisk,
  longOptionRisk,
  strategyRiskBlockers,
} from "./optionStrategyRisk";
import type {
  DirectionScores,
  MarketDirection,
  OptionLegPlan,
  OptionSide,
  StrategyCandidate,
  StrategyDecision,
  StrategyType,
  VolatilityDecision,
  VolatilityRegime,
} from "../types/optionStrategy";

interface OptionStrategySelectorInput {
  candidate: SignalCandidate;
  singleLegCandidates: ContractCandidate[];
  state: LiveState;
  nowIso: string;
  volatilityDecision: VolatilityDecision;
  optionsLevel?: number;
  hasLongStockPosition?: boolean;
}

interface LegWithQuote {
  contract: OptionContract;
  quote: OptionQuoteState;
}

export class OptionStrategySelector {
  constructor(private readonly config: AppConfig) {}

  select(input: OptionStrategySelectorInput): StrategyDecision {
    const directionScores = directionScoresFromCandidate(input.candidate);
    const allowed = allowedStrategies({
      marketRegime: input.candidate.regime,
      direction: directionScores.direction,
      volatilityRegime: input.volatilityDecision.regime,
      optionsLevel: input.optionsLevel ?? this.config.option_strategy.options_approval_level,
      hasLongStockPosition: input.hasLongStockPosition ?? false,
      enableCreditSpreads: this.config.option_strategy.enable_credit_spreads,
      enableIronCondor: this.config.option_strategy.enable_iron_condor,
      enableLongStraddles: this.config.option_strategy.enable_long_straddles,
    });
    const candidates = allowed
      .map((strategy) => this.buildStrategyCandidate(strategy, input, directionScores))
      .filter((candidate) => candidate.strategy !== "NO_TRADE");
    const scored = candidates.map((candidate) => ({
      ...candidate,
      score: scoreStrategyCandidate(candidate, {
        directionScores,
        volatilityRegime: input.volatilityDecision.regime,
        marketRegime: input.candidate.regime,
        minLossForPenalty: this.config.option_strategy.max_loss_per_trade_dollars,
      }),
    }));
    const valid = scored.filter((candidate) => candidate.blockers.length === 0);

    if (valid.length === 0) {
      return {
        action: "NO_TRADE",
        selected: null,
        candidates: scored,
        volatility: input.volatilityDecision,
        direction: directionScores,
        noTradeReason: "no_valid_strategy_candidate",
      };
    }

    const selected = [...valid].sort((a, b) => b.score - a.score || strategyPriority(a.strategy) - strategyPriority(b.strategy))[0];
    if (selected.score < this.config.option_strategy.min_strategy_score) {
      return {
        action: "NO_TRADE",
        selected: null,
        candidates: scored,
        volatility: input.volatilityDecision,
        direction: directionScores,
        noTradeReason: "strategy_score_too_low",
      };
    }

    return {
      action: "OPEN",
      selected,
      candidates: scored,
      volatility: input.volatilityDecision,
      direction: directionScores,
    };
  }

  private buildStrategyCandidate(
    strategy: StrategyType,
    input: OptionStrategySelectorInput,
    directionScores: DirectionScores,
  ): StrategyCandidate {
    switch (strategy) {
      case "LONG_CALL":
      case "LONG_PUT":
        return this.buildLongOption(strategy, input, directionScores);
      case "CALL_DEBIT_SPREAD":
      case "PUT_DEBIT_SPREAD":
        return this.buildDebitSpread(strategy, input, directionScores);
      case "PUT_CREDIT_SPREAD":
      case "CALL_CREDIT_SPREAD":
        return this.buildCreditSpread(strategy, input, directionScores);
      case "IRON_CONDOR":
        return this.buildIronCondor(input, directionScores);
      case "LONG_STRADDLE":
      case "LONG_STRANGLE":
        return this.buildLongVolatility(strategy, input, directionScores);
      default:
        return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["strategy_disabled"]);
    }
  }

  private buildLongOption(
    strategy: Extract<StrategyType, "LONG_CALL" | "LONG_PUT">,
    input: OptionStrategySelectorInput,
    directionScores: DirectionScores,
  ): StrategyCandidate {
    const right: OptionRight = strategy === "LONG_CALL" ? "call" : "put";
    const selected = input.singleLegCandidates.find((candidate) => candidate.contract.right === right);
    if (!selected) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["contract_not_found"]);
    }
    const mid = optionMid(selected.quote);
    const risk = mid === undefined ? { maxLossDollars: null, blockers: ["missing_debit"] } : longOptionRisk(mid);
    const candidate = baseCandidate({
      strategy,
      direction: directionScores.direction,
      optionSide: right === "call" ? "CALL" : "PUT",
      setupType: input.candidate.setupType,
      orderClass: "simple",
      debitOrCredit: "debit",
      expectedDebitOrCredit: mid ?? null,
      maxLossDollarsEstimate: risk.maxLossDollars,
      maxProfitDollarsEstimate: risk.maxProfitDollars,
      legs: [
        {
          symbol: selected.contract.symbol,
          side: "buy",
          positionIntent: "buy_to_open",
          ratioQty: 1,
          limitPriceEstimate: mid,
        },
      ],
      reasons: [`${strategy.toLowerCase()}_candidate`, ...selected.reason_codes],
      blockers: risk.blockers,
    });
    return this.withRiskBlockers(candidate, input);
  }

  private buildDebitSpread(
    strategy: Extract<StrategyType, "CALL_DEBIT_SPREAD" | "PUT_DEBIT_SPREAD">,
    input: OptionStrategySelectorInput,
    directionScores: DirectionScores,
  ): StrategyCandidate {
    if (!this.config.option_strategy.enable_debit_spreads) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["debit_spreads_disabled"]);
    }
    const right: OptionRight = strategy === "CALL_DEBIT_SPREAD" ? "call" : "put";
    const longLeg = input.singleLegCandidates.find((candidate) => candidate.contract.right === right);
    if (!longLeg) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["contract_not_found"]);
    }
    const shortLeg = this.findDebitSpreadShortLeg(input.state, input.nowIso, longLeg.contract, right);
    if (!shortLeg) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["spread_contract_not_found"]);
    }
    const longMid = optionMid(longLeg.quote);
    const shortMid = optionMid(shortLeg.quote);
    const longAsk = longLeg.quote.ask;
    const shortBid = shortLeg.quote.bid;
    if (longMid === undefined || shortMid === undefined || longAsk === undefined || shortBid === undefined) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["spread_quote_invalid"]);
    }
    const width = Math.abs(shortLeg.contract.strike_price - longLeg.contract.strike_price);
    const netDebitMid = Math.max(0.01, longMid - shortMid);
    const conservativeDebit = Math.max(0.01, longAsk - shortBid);
    const risk = debitSpreadRisk(conservativeDebit, width);
    const blockers = [
      ...risk.blockers,
      ...(width <= this.config.option_strategy.max_spread_width ? [] : ["spread_width_too_wide"]),
      ...(conservativeDebit <= this.config.option_strategy.max_debit_per_spread ? [] : ["spread_debit_too_high"]),
    ];
    const candidate = baseCandidate({
      strategy,
      direction: directionScores.direction,
      optionSide: right === "call" ? "CALL" : "PUT",
      setupType: input.candidate.setupType,
      orderClass: "mleg",
      debitOrCredit: "debit",
      expectedDebitOrCredit: netDebitMid,
      maxLossDollarsEstimate: risk.maxLossDollars,
      maxProfitDollarsEstimate: risk.maxProfitDollars,
      legs: [
        {
          symbol: longLeg.contract.symbol,
          side: "buy",
          positionIntent: "buy_to_open",
          ratioQty: 1,
          limitPriceEstimate: longMid,
        },
        {
          symbol: shortLeg.contract.symbol,
          side: "sell",
          positionIntent: "sell_to_open",
          ratioQty: 1,
          limitPriceEstimate: shortMid,
        },
      ],
      reasons: [`${strategy.toLowerCase()}_candidate`, `spread_width_${width}`],
      blockers,
    });
    return this.withRiskBlockers(candidate, input);
  }

  private buildCreditSpread(
    strategy: Extract<StrategyType, "PUT_CREDIT_SPREAD" | "CALL_CREDIT_SPREAD">,
    input: OptionStrategySelectorInput,
    directionScores: DirectionScores,
  ): StrategyCandidate {
    if (!this.config.option_strategy.enable_credit_spreads) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["credit_spreads_disabled"]);
    }
    const right: OptionRight = strategy === "PUT_CREDIT_SPREAD" ? "put" : "call";
    const spread = this.findCreditSpread(input.state, input.nowIso, input.candidate.underlying, right);
    if (!spread) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["spread_contract_not_found"]);
    }
    const shortMid = optionMid(spread.shortLeg.quote);
    const longMid = optionMid(spread.longLeg.quote);
    const shortBid = spread.shortLeg.quote.bid;
    const longAsk = spread.longLeg.quote.ask;
    if (shortMid === undefined || longMid === undefined || shortBid === undefined || longAsk === undefined) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["spread_quote_invalid"]);
    }
    const width = Math.abs(spread.shortLeg.contract.strike_price - spread.longLeg.contract.strike_price);
    const netCreditMid = Math.max(0.01, shortMid - longMid);
    const conservativeCredit = Math.max(0, shortBid - longAsk);
    const risk = creditSpreadRisk(conservativeCredit, width);
    const blockers = [
      ...risk.blockers,
      ...(width <= this.config.option_strategy.max_spread_width ? [] : ["spread_width_too_wide"]),
      ...(conservativeCredit >= width * this.config.option_strategy.min_credit_pct_of_width ? [] : ["credit_too_small"]),
      ...creditSpreadStructureBlockers(strategy, input.candidate),
    ];
    const candidate = baseCandidate({
      strategy,
      direction: directionScores.direction,
      optionSide: right === "call" ? "CALL" : "PUT",
      setupType: input.candidate.setupType,
      orderClass: "mleg",
      debitOrCredit: "credit",
      expectedDebitOrCredit: netCreditMid,
      maxLossDollarsEstimate: risk.maxLossDollars,
      maxProfitDollarsEstimate: risk.maxProfitDollars,
      legs: [
        {
          symbol: spread.shortLeg.contract.symbol,
          side: "sell",
          positionIntent: "sell_to_open",
          ratioQty: 1,
          limitPriceEstimate: shortMid,
        },
        {
          symbol: spread.longLeg.contract.symbol,
          side: "buy",
          positionIntent: "buy_to_open",
          ratioQty: 1,
          limitPriceEstimate: longMid,
        },
      ],
      reasons: [`${strategy.toLowerCase()}_candidate`, `spread_width_${width}`],
      blockers,
    });
    return this.withRiskBlockers(candidate, input);
  }

  private buildIronCondor(input: OptionStrategySelectorInput, directionScores: DirectionScores): StrategyCandidate {
    if (!this.config.option_strategy.enable_iron_condor) {
      return emptyCandidate("IRON_CONDOR", directionScores.direction, input.candidate.setupType, ["iron_condor_disabled"]);
    }
    if (input.candidate.regime !== MarketRegime.CHOP_DOJI && input.candidate.regime !== MarketRegime.COMPRESSION) {
      return emptyCandidate("IRON_CONDOR", directionScores.direction, input.candidate.setupType, ["iron_condor_requires_stable_range"]);
    }
    const put = this.findCreditSpread(input.state, input.nowIso, input.candidate.underlying, "put", [0.1, 0.2]);
    const call = this.findCreditSpread(input.state, input.nowIso, input.candidate.underlying, "call", [0.1, 0.2]);
    if (!put || !call) {
      return emptyCandidate("IRON_CONDOR", directionScores.direction, input.candidate.setupType, ["iron_condor_legs_not_found"]);
    }
    const putCredit = spreadCredit(put.shortLeg.quote, put.longLeg.quote);
    const callCredit = spreadCredit(call.shortLeg.quote, call.longLeg.quote);
    if (putCredit === undefined || callCredit === undefined) {
      return emptyCandidate("IRON_CONDOR", directionScores.direction, input.candidate.setupType, ["spread_quote_invalid"]);
    }
    const putWidth = Math.abs(put.shortLeg.contract.strike_price - put.longLeg.contract.strike_price);
    const callWidth = Math.abs(call.shortLeg.contract.strike_price - call.longLeg.contract.strike_price);
    const netCredit = putCredit + callCredit;
    const risk = ironCondorRisk(netCredit, callWidth, putWidth);
    const candidate = baseCandidate({
      strategy: "IRON_CONDOR",
      direction: "NEUTRAL",
      optionSide: "BOTH",
      setupType: input.candidate.setupType,
      orderClass: "mleg",
      debitOrCredit: "credit",
      expectedDebitOrCredit: netCredit,
      maxLossDollarsEstimate: risk.maxLossDollars,
      maxProfitDollarsEstimate: risk.maxProfitDollars,
      legs: [
        legPlan(put.shortLeg, "sell"),
        legPlan(put.longLeg, "buy"),
        legPlan(call.shortLeg, "sell"),
        legPlan(call.longLeg, "buy"),
      ],
      reasons: ["iron_condor_candidate"],
      blockers: risk.blockers,
    });
    return this.withRiskBlockers(candidate, input);
  }

  private buildLongVolatility(strategy: "LONG_STRADDLE" | "LONG_STRANGLE", input: OptionStrategySelectorInput, directionScores: DirectionScores): StrategyCandidate {
    if (!this.config.option_strategy.enable_long_straddles) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["long_straddles_disabled"]);
    }
    if (input.candidate.regime !== MarketRegime.COMPRESSION) {
      return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["long_vol_requires_compression"]);
    }
    return emptyCandidate(strategy, directionScores.direction, input.candidate.setupType, ["long_vol_strategy_not_implemented"]);
  }

  private withRiskBlockers(candidate: StrategyCandidate, input: OptionStrategySelectorInput): StrategyCandidate {
    const blockers = strategyRiskBlockers(candidate, {
      config: this.config,
      marketRegime: input.candidate.regime,
      nowIso: input.nowIso,
    });
    return {
      ...candidate,
      blockers: [...new Set([...candidate.blockers, ...blockers])],
    };
  }

  private findDebitSpreadShortLeg(
    state: LiveState,
    nowIso: string,
    longContract: OptionContract,
    right: OptionRight,
  ): LegWithQuote | undefined {
    const candidates = this.optionLegs(state, longContract.underlying_symbol, right, nowIso)
      .filter((item) => item.contract.expiration_date === longContract.expiration_date)
      .filter((item) =>
        right === "call" ? item.contract.strike_price > longContract.strike_price : item.contract.strike_price < longContract.strike_price,
      )
      .filter((item) => {
        const delta = absDelta(item.quote);
        return delta === undefined || (delta >= 0.2 && delta <= 0.35);
      })
      .filter((item) => Math.abs(item.contract.strike_price - longContract.strike_price) <= this.config.option_strategy.max_spread_width);
    return candidates.sort((a, b) => Math.abs(a.contract.strike_price - longContract.strike_price) - Math.abs(b.contract.strike_price - longContract.strike_price))[0];
  }

  private findCreditSpread(
    state: LiveState,
    nowIso: string,
    underlying: string,
    right: OptionRight,
    shortDeltaRange: [number, number] = [0.15, 0.3],
  ): { shortLeg: LegWithQuote; longLeg: LegWithQuote } | undefined {
    const shortLegs = this.optionLegs(state, underlying, right, nowIso)
      .filter((item) => {
        const delta = absDelta(item.quote);
        return delta === undefined || (delta >= shortDeltaRange[0] && delta <= shortDeltaRange[1]);
      })
      .sort((a, b) => a.contract.strike_price - b.contract.strike_price);
    for (const shortLeg of shortLegs) {
      const longLeg = this.optionLegs(state, underlying, right, nowIso)
        .filter((item) => item.contract.expiration_date === shortLeg.contract.expiration_date)
        .filter((item) =>
          right === "put" ? item.contract.strike_price < shortLeg.contract.strike_price : item.contract.strike_price > shortLeg.contract.strike_price,
        )
        .filter((item) => Math.abs(item.contract.strike_price - shortLeg.contract.strike_price) <= this.config.option_strategy.max_spread_width)
        .sort((a, b) => Math.abs(a.contract.strike_price - shortLeg.contract.strike_price) - Math.abs(b.contract.strike_price - shortLeg.contract.strike_price))[0];
      if (longLeg) {
        return { shortLeg, longLeg };
      }
    }
    return undefined;
  }

  private optionLegs(state: LiveState, underlying: string, right: OptionRight, nowIso: string): LegWithQuote[] {
    const output: LegWithQuote[] = [];
    for (const contract of state.contracts.values()) {
      if (contract.underlying_symbol !== underlying || contract.right !== right || contract.status === "inactive") {
        continue;
      }
      const quote = state.optionQuotes.get(contract.symbol);
      if (!quote || optionMid(quote) === undefined) {
        continue;
      }
      output.push({ contract, quote });
    }
    return output.filter((item) => item.quote.received_at_utc === undefined || Date.parse(nowIso) - Date.parse(item.quote.received_at_utc) <= this.config.stream.max_quote_age_seconds * 1000);
  }
}

export function directionScoresFromCandidate(candidate: SignalCandidate): DirectionScores {
  const score = Math.max(0, Math.min(100, candidate.score));
  const counterScore = Math.max(0, 100 - score);
  if (candidate.direction === "BULLISH") {
    return {
      bullScore: score,
      bearScore: counterScore,
      neutralScore: Math.max(0, 50 - candidate.confidence * 20),
      direction: "BULLISH",
      scoreGap: score - counterScore,
      reasons: ["candidate_bullish_score"],
    };
  }
  return {
    bullScore: counterScore,
    bearScore: score,
    neutralScore: Math.max(0, 50 - candidate.confidence * 20),
    direction: "BEARISH",
    scoreGap: score - counterScore,
    reasons: ["candidate_bearish_score"],
  };
}

function scoreStrategyCandidate(
  candidate: StrategyCandidate,
  input: {
    directionScores: DirectionScores;
    volatilityRegime: VolatilityRegime;
    marketRegime: MarketRegime;
    minLossForPenalty: number | null;
  },
): number {
  const directionScore =
    candidate.direction === "BULLISH"
      ? input.directionScores.bullScore
      : candidate.direction === "BEARISH"
        ? input.directionScores.bearScore
        : input.directionScores.neutralScore;
  const volFit = volatilityFitScore(candidate.strategy, input.volatilityRegime);
  const regimeFit = regimeFitScore(candidate.strategy, input.marketRegime, candidate.setupType);
  const liquidityScore = optionLiquidityScore(candidate);
  const riskPenalty = estimatedRiskPenalty(candidate, input.minLossForPenalty);
  const blockerPenalty = candidate.blockers.length * 30;
  return directionScore + volFit + regimeFit + liquidityScore - riskPenalty - blockerPenalty;
}

export function volatilityFitScore(strategy: StrategyType, vol: VolatilityRegime): number {
  const longPremium: StrategyType[] = ["LONG_CALL", "LONG_PUT", "LONG_STRADDLE", "LONG_STRANGLE"];
  const debitSpread: StrategyType[] = ["CALL_DEBIT_SPREAD", "PUT_DEBIT_SPREAD"];
  const creditSpread: StrategyType[] = ["PUT_CREDIT_SPREAD", "CALL_CREDIT_SPREAD", "IRON_CONDOR"];

  if (vol === "LOW_IV") {
    if (longPremium.includes(strategy)) return 25;
    if (debitSpread.includes(strategy)) return 15;
    if (creditSpread.includes(strategy)) return -20;
  }
  if (vol === "NORMAL_IV") {
    if (debitSpread.includes(strategy)) return 15;
    if (longPremium.includes(strategy)) return 5;
    if (creditSpread.includes(strategy)) return 0;
  }
  if (vol === "HIGH_IV") {
    if (creditSpread.includes(strategy)) return 20;
    if (debitSpread.includes(strategy)) return 10;
    if (longPremium.includes(strategy)) return -10;
  }
  if (vol === "EXTREME_IV") {
    if (debitSpread.includes(strategy)) return 0;
    if (creditSpread.includes(strategy)) return -30;
    if (longPremium.includes(strategy)) return -25;
  }
  return 0;
}

export function regimeFitScore(strategy: StrategyType, regime: MarketRegime, setup: string): number {
  const directionalLong: StrategyType[] = ["LONG_CALL", "LONG_PUT", "CALL_DEBIT_SPREAD", "PUT_DEBIT_SPREAD"];
  const creditDirectional: StrategyType[] = ["PUT_CREDIT_SPREAD", "CALL_CREDIT_SPREAD"];

  if (regime === MarketRegime.STRONG_UP || regime === MarketRegime.STRONG_DOWN) {
    if (directionalLong.includes(strategy)) return 25;
    if (creditDirectional.includes(strategy)) return 0;
    return -20;
  }
  if (regime === MarketRegime.GRIND_UP || regime === MarketRegime.GRIND_DOWN) {
    if (directionalLong.includes(strategy)) return 15;
    if (creditDirectional.includes(strategy)) return 15;
    return -10;
  }
  if (regime === MarketRegime.CHOP_DOJI) {
    if (strategy === "IRON_CONDOR") return 25;
    if (strategy === "LONG_STRADDLE" && setup === "COMPRESSION_BREAKOUT") return 10;
    return -25;
  }
  if (regime === MarketRegime.HIGH_VOL_WHIPSAW) {
    if (strategy === "CALL_DEBIT_SPREAD" || strategy === "PUT_DEBIT_SPREAD") return -5;
    return -40;
  }
  if (regime === MarketRegime.REVERSAL_UP || regime === MarketRegime.REVERSAL_DOWN) {
    if (directionalLong.includes(strategy)) return 20;
    if (creditDirectional.includes(strategy)) return -10;
    return -20;
  }
  if (regime === MarketRegime.GAP_AND_GO_UP || regime === MarketRegime.GAP_AND_GO_DOWN) {
    if (directionalLong.includes(strategy)) return 25;
    if (creditDirectional.includes(strategy)) return -15;
    return -20;
  }
  return 0;
}

function optionLiquidityScore(candidate: StrategyCandidate): number {
  const pricedLegCount = candidate.legs.filter((leg) => leg.limitPriceEstimate !== undefined && leg.limitPriceEstimate > 0).length;
  return candidate.legs.length === 0 ? 0 : 10 * (pricedLegCount / candidate.legs.length);
}

function estimatedRiskPenalty(candidate: StrategyCandidate, maxLossLimit: number | null): number {
  if (candidate.maxLossDollarsEstimate === null || maxLossLimit === null || maxLossLimit <= 0) {
    return 0;
  }
  return Math.max(0, (candidate.maxLossDollarsEstimate / maxLossLimit - 1) * 20);
}

function creditSpreadStructureBlockers(strategy: StrategyType, candidate: SignalCandidate): string[] {
  if (candidate.regime === MarketRegime.HIGH_VOL_WHIPSAW) {
    return ["credit_strategy_blocked_in_high_vol_whipsaw"];
  }
  if (strategy === "PUT_CREDIT_SPREAD" && candidate.regime !== MarketRegime.GRIND_UP) {
    return ["credit_spread_requires_stable_grind_up"];
  }
  if (strategy === "CALL_CREDIT_SPREAD" && candidate.regime !== MarketRegime.GRIND_DOWN) {
    return ["credit_spread_requires_stable_grind_down"];
  }
  if (candidate.featureSnapshot.trendEfficiency20 < 0.45) {
    return ["trend_efficiency_too_low_for_credit_spread"];
  }
  return [];
}

function emptyCandidate(
  strategy: StrategyType,
  direction: MarketDirection,
  setupType: StrategyCandidate["setupType"],
  blockers: string[],
): StrategyCandidate {
  return baseCandidate({
    strategy,
    direction,
    optionSide: "NONE",
    setupType,
    orderClass: strategy === "NO_TRADE" ? undefined : "simple",
    debitOrCredit: undefined,
    expectedDebitOrCredit: null,
    maxLossDollarsEstimate: null,
    maxProfitDollarsEstimate: null,
    legs: [],
    reasons: [],
    blockers,
  });
}

function baseCandidate(params: Omit<StrategyCandidate, "score">): StrategyCandidate {
  return {
    ...params,
    score: 0,
    blockers: [...new Set(params.blockers)],
  };
}

function legPlan(leg: LegWithQuote, side: "buy" | "sell"): OptionLegPlan {
  return {
    symbol: leg.contract.symbol,
    side,
    positionIntent: side === "buy" ? "buy_to_open" : "sell_to_open",
    ratioQty: 1,
    limitPriceEstimate: optionMid(leg.quote),
  };
}

function spreadCredit(shortQuote: OptionQuoteState, longQuote: OptionQuoteState): number | undefined {
  const shortMid = optionMid(shortQuote);
  const longMid = optionMid(longQuote);
  return shortMid === undefined || longMid === undefined ? undefined : Math.max(0.01, shortMid - longMid);
}

function absDelta(quote: OptionQuoteState): number | undefined {
  return quote.delta === undefined ? undefined : Math.abs(quote.delta);
}

function strategyPriority(strategy: StrategyType): number {
  switch (strategy) {
    case "LONG_CALL":
    case "LONG_PUT":
      return 0;
    case "CALL_DEBIT_SPREAD":
    case "PUT_DEBIT_SPREAD":
      return 1;
    case "PUT_CREDIT_SPREAD":
    case "CALL_CREDIT_SPREAD":
      return 2;
    case "IRON_CONDOR":
      return 3;
    default:
      return 9;
  }
}
