import type { AppConfig } from "../config/config";
import type { LiveState } from "./state";
import type { OptionContract, OptionQuoteState, UnderlyingBarPoint } from "./types";
import type { VolatilityDecision, VolatilityFeatures } from "../types/optionStrategy";
import { secondsFromClock, secondsSinceMidnightInZone } from "../util/time";

const TRADING_DAYS = 252;
const MINUTES_PER_DAY = 390;

export class VolatilityRegimeEngine {
  constructor(private readonly config: AppConfig) {}

  features(state: LiveState, underlying: string, nowIso: string): VolatilityFeatures {
    return buildVolatilityFeatures(state, underlying, nowIso, this.config);
  }

  classify(features: VolatilityFeatures): VolatilityDecision {
    return classifyVolatility(features, this.config);
  }
}

export function buildVolatilityFeatures(
  state: LiveState,
  underlying: string,
  nowIso: string,
  config: AppConfig,
): VolatilityFeatures {
  const symbol = underlying.toUpperCase();
  const underlyingState = state.underlyings.get(symbol);
  const price = underlyingState?.last_price;
  const contracts = [...state.contracts.values()].filter((contract) => contract.underlying_symbol === symbol);
  const quotes = contracts
    .map((contract) => ({ contract, quote: state.optionQuotes.get(contract.symbol) }))
    .filter((item): item is { contract: OptionContract; quote: OptionQuoteState } => item.quote !== undefined);
  const ivs = quotes
    .map((item) => item.quote.implied_volatility)
    .filter((iv): iv is number => typeof iv === "number" && Number.isFinite(iv) && iv > 0);
  const chainIv = averageOrNull(ivs);
  const atmIv = price === undefined ? null : nearestAtmIv(quotes, price);
  const currentIv = atmIv ?? chainIv;
  const bars = state.barHistory.get(symbol) ?? [];
  const realizedVolIntraday = intradayRealizedVol(bars);
  const ivToRvRatio = currentIv !== null && realizedVolIntraday !== null && realizedVolIntraday > 0 ? currentIv / realizedVolIntraday : null;
  const ivMinusRv = currentIv !== null && realizedVolIntraday !== null ? currentIv - realizedVolIntraday : null;
  const expectedMoveBpsToClose =
    currentIv !== null ? expectedMoveBps(currentIv, minutesToClose(nowIso, config), price) : null;
  const realizedMoveBpsFromOpen =
    price !== undefined && (underlyingState?.session_open ?? bars[0]?.open) !== undefined
      ? bps(price, underlyingState?.session_open ?? bars[0].open)
      : null;
  const ivHistory = ivHistoryForUnderlying(state, contracts);
  const intradayIvZScore = currentIv === null ? null : zScore(currentIv, ivHistory);

  return {
    underlying: symbol,
    chainIv,
    atmIv,
    ivRank20d: null,
    ivRank252d: null,
    ivPercentile20d: null,
    realizedVol20d: null,
    realizedVolIntraday,
    ivToRvRatio,
    ivMinusRv,
    expectedMoveBpsToClose,
    realizedMoveBpsFromOpen,
    intradayIvZScore,
  };
}

export function classifyVolatility(features: VolatilityFeatures, config?: AppConfig): VolatilityDecision {
  const reasons: string[] = [];
  const thresholds = config?.volatility ?? {
    low_iv_rank_max: 0.3,
    high_iv_rank_min: 0.7,
    extreme_iv_rank_min: 0.9,
    high_iv_to_rv_min: 1.25,
    extreme_intraday_iv_z_min: 2,
    min_iv_history_points: 20,
  };
  const ivRank = features.ivRank20d ?? features.ivRank252d;
  const ivToRv = features.ivToRvRatio;
  const z = features.intradayIvZScore;

  if (features.atmIv == null && features.chainIv == null) {
    return {
      regime: "UNKNOWN_IV",
      confidence: 0,
      reasons: ["missing_iv"],
      features,
    };
  }

  if (
    (ivRank != null && ivRank >= thresholds.extreme_iv_rank_min) ||
    (z != null && z >= thresholds.extreme_intraday_iv_z_min)
  ) {
    reasons.push("iv_extreme_by_rank_or_intraday_zscore");
    return { regime: "EXTREME_IV", confidence: 0.85, reasons, features };
  }

  if ((ivRank != null && ivRank >= thresholds.high_iv_rank_min) || (ivToRv != null && ivToRv >= thresholds.high_iv_to_rv_min)) {
    reasons.push("high_iv_by_rank_or_iv_to_rv");
    return { regime: "HIGH_IV", confidence: 0.75, reasons, features };
  }

  if (ivRank != null && ivRank <= thresholds.low_iv_rank_max && (ivToRv == null || ivToRv <= 1.05)) {
    reasons.push("low_iv_by_rank_and_not_expensive_vs_rv");
    return { regime: "LOW_IV", confidence: 0.75, reasons, features };
  }

  reasons.push("normal_iv");
  return { regime: "NORMAL_IV", confidence: 0.6, reasons, features };
}

export function ivRank(currentIv: number, historicalIvs: number[]): number | null {
  const values = historicalIvs.filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return null;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) {
    return null;
  }
  return (currentIv - min) / (max - min);
}

export function ivPercentile(currentIv: number, historicalIvs: number[]): number | null {
  const values = historicalIvs.filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return null;
  }
  return values.filter((value) => value <= currentIv).length / values.length;
}

function nearestAtmIv(items: Array<{ contract: OptionContract; quote: OptionQuoteState }>, price: number): number | null {
  const sorted = items
    .filter((item) => item.quote.implied_volatility !== undefined && item.quote.implied_volatility > 0)
    .sort((a, b) => Math.abs(a.contract.strike_price - price) - Math.abs(b.contract.strike_price - price));
  return sorted[0]?.quote.implied_volatility ?? null;
}

function intradayRealizedVol(bars: UnderlyingBarPoint[]): number | null {
  if (bars.length < 3) {
    return null;
  }
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const previous = bars[i - 1].close;
    const current = bars[i].close;
    if (previous > 0 && current > 0) {
      returns.push(Math.log(current / previous));
    }
  }
  const sd = stddev(returns);
  return sd === null ? null : sd * Math.sqrt(TRADING_DAYS * MINUTES_PER_DAY);
}

function expectedMoveBps(currentIv: number, minutesRemaining: number, underlyingPrice?: number): number | null {
  if (underlyingPrice === undefined || underlyingPrice <= 0 || currentIv <= 0) {
    return null;
  }
  const yearsToClose = Math.max(1, minutesRemaining) / (TRADING_DAYS * MINUTES_PER_DAY);
  return 10_000 * currentIv * Math.sqrt(yearsToClose);
}

function minutesToClose(nowIso: string, config: AppConfig): number {
  const closeSeconds = secondsFromClock(config.session.regular_close_et);
  const nowSeconds = secondsSinceMidnightInZone(new Date(nowIso), config.system.timezone);
  return Math.max(1, Math.ceil((closeSeconds - nowSeconds) / 60));
}

function ivHistoryForUnderlying(state: LiveState, contracts: OptionContract[]): number[] {
  const symbols = new Set(contracts.map((contract) => contract.symbol));
  const values: number[] = [];
  for (const [symbol, points] of state.optionIvHistory.entries()) {
    if (!symbols.has(symbol)) {
      continue;
    }
    values.push(...points.map((point) => point.value));
  }
  return values;
}

function zScore(current: number, values: number[]): number | null {
  if (values.length < 3) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = stddev(values);
  return sd === null || sd === 0 ? null : (current - mean) / sd;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function averageOrNull(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bps(currentPrice: number, referencePrice: number): number {
  return referencePrice > 0 ? (10_000 * (currentPrice - referencePrice)) / referencePrice : 0;
}
