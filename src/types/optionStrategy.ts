import type { MarketRegime, RegimeFeatureSnapshot } from "../domain/regimeTypes";
import type { SetupType as SignalSetupType } from "../domain/signalTypes";

export type MarketDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export type VolatilityRegime = "LOW_IV" | "NORMAL_IV" | "HIGH_IV" | "EXTREME_IV" | "UNKNOWN_IV";

export type OptionSide = "CALL" | "PUT" | "BOTH" | "NONE";

export type StrategyType =
  | "LONG_CALL"
  | "LONG_PUT"
  | "CALL_DEBIT_SPREAD"
  | "PUT_DEBIT_SPREAD"
  | "PUT_CREDIT_SPREAD"
  | "CALL_CREDIT_SPREAD"
  | "IRON_CONDOR"
  | "LONG_STRADDLE"
  | "LONG_STRANGLE"
  | "PROTECTIVE_PUT"
  | "COLLAR"
  | "NO_TRADE";

export type SetupType = SignalSetupType | "COMPRESSION_BREAKOUT" | "NEUTRAL_RANGE_SELLING" | "NO_SETUP";

export interface DirectionScores {
  bullScore: number;
  bearScore: number;
  neutralScore: number;
  direction: MarketDirection;
  scoreGap: number;
  reasons: string[];
}

export interface VolatilityFeatures {
  underlying: string;
  chainIv: number | null;
  atmIv: number | null;
  ivRank20d: number | null;
  ivRank252d: number | null;
  ivPercentile20d: number | null;
  realizedVol20d: number | null;
  realizedVolIntraday: number | null;
  ivToRvRatio: number | null;
  ivMinusRv: number | null;
  expectedMoveBpsToClose: number | null;
  realizedMoveBpsFromOpen: number | null;
  intradayIvZScore: number | null;
}

export interface VolatilityDecision {
  regime: VolatilityRegime;
  confidence: number;
  reasons: string[];
  features: VolatilityFeatures;
}

export interface OptionLegPlan {
  symbol: string;
  side: "buy" | "sell";
  positionIntent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
  ratioQty: number;
  limitPriceEstimate?: number;
}

export interface OptionOrderPlan {
  strategy: StrategyType;
  orderClass: "simple" | "mleg";
  qty: number;
  netLimitPrice: number;
  debitOrCredit: "debit" | "credit";
  timeInForce: "day";
  legs: OptionLegPlan[];
  maxLossDollars: number;
  maxProfitDollars?: number;
  entryReason: string;
  blockers: string[];
}

export interface StrategyCandidate {
  strategy: StrategyType;
  direction: MarketDirection;
  optionSide: OptionSide;
  setupType: SetupType;
  score: number;
  maxLossDollarsEstimate: number | null;
  maxProfitDollarsEstimate?: number | null;
  expectedDebitOrCredit: number | null;
  debitOrCredit?: "debit" | "credit";
  orderClass?: "simple" | "mleg";
  legs: OptionLegPlan[];
  reasons: string[];
  blockers: string[];
}

export interface StrategyDecision {
  action: "OPEN" | "NO_TRADE";
  selected: StrategyCandidate | null;
  candidates: StrategyCandidate[];
  volatility: VolatilityDecision;
  direction: DirectionScores;
  noTradeReason?: string;
}

export interface StrategyPolicyInput {
  marketRegime: MarketRegime;
  direction: MarketDirection;
  volatilityRegime: VolatilityRegime;
  optionsLevel: number;
  hasLongStockPosition: boolean;
  enableCreditSpreads: boolean;
  enableIronCondor: boolean;
  enableLongStraddles: boolean;
}

export interface OptionStrategySelectorInput {
  marketRegime: MarketRegime;
  directionScores: DirectionScores;
  volatilityDecision: VolatilityDecision;
  setupType: SetupType;
  featureSnapshot: RegimeFeatureSnapshot;
  stateNowIso: string;
}
