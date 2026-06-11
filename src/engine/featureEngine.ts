import type { AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import { optionMid } from "../domain/types";
import type { RegimeFeatureSnapshot } from "../domain/regimeTypes";
import { secondsBetweenIso } from "../util/time";

export interface UnderlyingFeatures {
  symbol: string;
  price?: number;
  bid?: number;
  ask?: number;
  mid?: number;
  spread?: number;
  vwap?: number;
  opening_range_high?: number;
  opening_range_low?: number;
  opening_range_bps?: number;
  session_high?: number;
  session_low?: number;
  quote_age_seconds: number;
  short_momentum_bps: number;
}

export class FeatureEngine {
  constructor(private readonly config: AppConfig) {}

  underlyingFeatures(state: LiveState, symbol: string, nowIso: string): UnderlyingFeatures {
    const underlying = state.underlyings.get(symbol);
    const bid = underlying?.bid;
    const ask = underlying?.ask;
    return {
      symbol,
      price: underlying?.last_price,
      bid,
      ask,
      mid: bid !== undefined && ask !== undefined && ask > bid ? (bid + ask) / 2 : undefined,
      spread: bid !== undefined && ask !== undefined && ask > bid ? ask - bid : undefined,
      vwap: underlying?.vwap,
      opening_range_high: underlying?.opening_range_high,
      opening_range_low: underlying?.opening_range_low,
      opening_range_bps:
        underlying?.opening_range_high !== undefined && underlying.opening_range_low !== undefined && underlying.last_price !== undefined
          ? ((underlying.opening_range_high - underlying.opening_range_low) / underlying.last_price) * 10_000
          : undefined,
      session_high: underlying?.session_high,
      session_low: underlying?.session_low,
      quote_age_seconds: secondsBetweenIso(underlying?.last_received_at_utc, nowIso),
      short_momentum_bps: state.getMomentumBps(symbol, nowIso, Math.max(30, this.config.strategy.opening_range_minutes * 60)),
    };
  }

  optionFeatures(state: LiveState, symbol: string, nowIso: string): Record<string, unknown> {
    const quote = state.optionQuotes.get(symbol);
    const mid = optionMid(quote);
    const spread = quote?.bid !== undefined && quote.ask !== undefined ? quote.ask - quote.bid : undefined;
    return {
      symbol,
      bid: quote?.bid,
      ask: quote?.ask,
      mid,
      spread,
      spread_pct_of_mid: mid && spread !== undefined ? spread / mid : undefined,
      quote_age_seconds: secondsBetweenIso(quote?.received_at_utc, nowIso),
      delta: quote?.delta,
      theta: quote?.theta,
      gamma: quote?.gamma,
      implied_volatility: quote?.implied_volatility,
    };
  }

  regimeFeatures(state: LiveState, symbol: string, nowIso: string): RegimeFeatureSnapshot | undefined {
    const underlying = state.underlyings.get(symbol);
    if (!underlying) {
      return undefined;
    }
    const price = underlying?.last_price;
    const vwap = underlying?.vwap;
    const openingRangeHigh = underlying?.opening_range_high;
    const openingRangeLow = underlying?.opening_range_low;
    if (price === undefined || vwap === undefined || openingRangeHigh === undefined || openingRangeLow === undefined) {
      return undefined;
    }
    const bars = [...(state.barHistory.get(symbol) ?? [])]
      .filter((bar) => Date.parse(bar.at) <= Date.parse(nowIso))
      .sort((a, b) => a.at.localeCompare(b.at));
    if (bars.length === 0) {
      return undefined;
    }
    const closes = bars.map((bar) => bar.close);
    const highs = bars.map((bar) => bar.high);
    const lows = bars.map((bar) => bar.low);
    const vwaps = bars.map((bar) => bar.vwap ?? vwap);
    const volumes = bars.map((bar) => bar.volume ?? 0);
    const ema9Series = emaSeries(closes, 9);
    const ema21Series = emaSeries(closes, 21);
    const ema50Series = emaSeries(closes, 50);
    const ema9 = last(ema9Series) ?? price;
    const ema21 = last(ema21Series) ?? price;
    const ema50 = last(ema50Series) ?? price;
    const sessionOpen = underlying.session_open ?? bars[0]?.open ?? price;
    const previousClose = underlying.previous_close;
    const gapBps = previousClose === undefined ? 0 : bps(sessionOpen - previousClose, previousClose);
    const openingRangeMid = (openingRangeHigh + openingRangeLow) / 2;
    const recentHigh10 = Math.max(...highs.slice(-10));
    const recentLow10 = Math.min(...lows.slice(-10));
    const recentHigh20 = Math.max(...highs.slice(-20));
    const recentLow20 = Math.min(...lows.slice(-20));
    const currentBar = bars[bars.length - 1];
    const currentRange = Math.max(0, currentBar.high - currentBar.low);
    const currentRangeBps = bps(currentRange, price);
    const rangeBps = bars.slice(-20).map((bar) => bps(Math.max(0, bar.high - bar.low), bar.close || price));
    const medianRange = median(rangeBps) || currentRangeBps || 1;
    const returnBps1m = returnBps(closes, 1);
    const returnBps3m = returnBps(closes, 3);
    const returnBps5m = returnBps(closes, 5);
    const ema9Slope1m = slopeBpsPerMin(ema9Series, bars, 1, price);
    const ema9Slope3m = slopeBpsPerMin(ema9Series, bars, 3, price);
    const ema21Slope3m = slopeBpsPerMin(ema21Series, bars, 3, price);
    const vwapSlope3m = slopeBpsPerMin(vwaps, bars, 3, price);
    const ema9Acceleration = ema9Slope1m - ema9Slope3m;
    const regressionSlope = regressionSlopeBpsPerMin(closes.slice(-20), price);
    const regressionR2Value = regressionR2(closes.slice(-20));
    return {
      price,
      vwap,
      ema9,
      ema21,
      ema50,
      priceToVwapBps: bps(price - vwap, vwap),
      openingRangeHigh,
      openingRangeLow,
      openingRangeMid,
      openingRangeBps: bps(openingRangeHigh - openingRangeLow, price),
      priceToOrHighBps: bps(price - openingRangeHigh, openingRangeHigh),
      priceToOrLowBps: bps(price - openingRangeLow, openingRangeLow),
      gapBps,
      gapFillPct: previousClose === undefined ? 0 : gapFillPct(gapBps, sessionOpen, previousClose, price),
      ema9Slope1m,
      ema9Slope3m,
      ema21Slope3m,
      vwapSlope3m,
      ema9Acceleration,
      regressionSlope,
      ema9SlopeBpsPerMin: ema9Slope1m,
      ema21SlopeBpsPerMin: ema21Slope3m,
      ema50SlopeBpsPerMin: slopeBpsPerMin(ema50Series, bars, 20, price),
      vwapSlopeBpsPerMin: vwapSlope3m,
      ema9AccelerationBps: ema9Acceleration,
      ema21AccelerationBps: slopeBpsPerMin(ema21Series, bars, 3, price) - slopeBpsPerMin(ema21Series, bars, 12, price),
      regressionSlopeBpsPerMin: regressionSlope,
      regressionR2: regressionR2Value,
      trendEfficiency10: trendEfficiency(closes, 10),
      trendEfficiency20: trendEfficiency(closes, 20),
      realizedVolBps1m: realizedVolBps(closes, 10),
      atrBps1m: average(rangeBps.slice(-10)),
      rangeExpansionRatio: currentRangeBps / Math.max(0.0001, medianRange),
      candleBodyPct: currentRange > 0 ? Math.abs(currentBar.close - currentBar.open) / currentRange : 0,
      wickPct: currentRange > 0 ? 1 - Math.abs(currentBar.close - currentBar.open) / currentRange : 1,
      dojiRate10: dojiRate(bars, 10),
      vwapCrossCount10: vwapCrossCount(closes, vwaps, 10),
      alternatingBarRate10: alternatingBarRate(closes, 10),
      higherLowCount: higherLowCount(lows, 6),
      lowerHighCount: lowerHighCount(highs, 6),
      pullbackDepthBps: price >= vwap ? bps(recentHigh20 - price, price) : bps(price - recentLow20, price),
      returnBps1m,
      returnBps3m,
      returnBps5m,
      shortMomentumBps: state.getMomentumBps(symbol, nowIso, Math.max(30, this.config.strategy.opening_range_minutes * 60)),
      momentumAccelerationBps: returnBps1m - returnBps3m / 3,
      relativeVolume: underlying.relative_volume ?? relativeVolume(volumes),
      priorHigh1m: highs.length > 1 ? highs[highs.length - 2] : price,
      priorLow1m: lows.length > 1 ? lows[lows.length - 2] : price,
      priorHigh3m: Math.max(...highs.slice(Math.max(0, highs.length - 4), -1), price),
      priorLow3m: Math.min(...lows.slice(Math.max(0, lows.length - 4), -1), price),
      compressionRangeBps: bps(Math.max(...highs.slice(-8)) - Math.min(...lows.slice(-8)), price),
    };
  }
}

function bps(value: number, reference: number): number {
  return reference === 0 ? 0 : (value / reference) * 10_000;
}

function gapFillPct(gapBpsValue: number, sessionOpen: number, previousClose: number, price: number): number {
  const gapSize = Math.abs(sessionOpen - previousClose);
  if (gapSize <= 0 || gapBpsValue === 0) {
    return 0;
  }
  const filled = gapBpsValue > 0 ? Math.max(0, sessionOpen - price) : Math.max(0, price - sessionOpen);
  return Math.max(0, Math.min(1, filled / gapSize));
}

function last(values: number[]): number | undefined {
  return values[values.length - 1];
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) {
    return [];
  }
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    output.push(values[i] * alpha + output[i - 1] * (1 - alpha));
  }
  return output;
}

function slopeBpsPerMin(values: number[], bars: Array<{ at: string }>, lookback: number, price: number): number {
  if (values.length < 2) {
    return 0;
  }
  const end = values.length - 1;
  const start = Math.max(0, end - lookback);
  const minutes = Math.max(1 / 60, (Date.parse(bars[end].at) - Date.parse(bars[start].at)) / 60_000);
  return bps(values[end] - values[start], price) / minutes;
}

function regressionSlopeBpsPerMin(values: number[], price: number): number {
  if (values.length < 2) {
    return 0;
  }
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return bps(denominator === 0 ? 0 : numerator / denominator, price);
}

function regressionR2(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let xDenominator = 0;
  let yDenominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - xMean) * (values[i] - yMean);
    xDenominator += (i - xMean) ** 2;
    yDenominator += (values[i] - yMean) ** 2;
  }
  if (xDenominator === 0 || yDenominator === 0) {
    return 0;
  }
  const r = numerator / Math.sqrt(xDenominator * yDenominator);
  return Math.max(0, Math.min(1, r * r));
}

function trendEfficiency(values: number[], lookback: number): number {
  const recent = values.slice(-(lookback + 1));
  if (recent.length < 2) {
    return 0;
  }
  const directional = Math.abs(recent[recent.length - 1] - recent[0]);
  let path = 0;
  for (let i = 1; i < recent.length; i += 1) {
    path += Math.abs(recent[i] - recent[i - 1]);
  }
  return path === 0 ? 0 : Math.min(1, directional / path);
}

function returnBps(values: number[], lookback: number): number {
  if (values.length <= lookback) {
    return 0;
  }
  const start = values[values.length - 1 - lookback];
  const end = values[values.length - 1];
  return bps(end - start, start);
}

function realizedVolBps(values: number[], lookback: number): number {
  const returns: number[] = [];
  const recent = values.slice(-(lookback + 1));
  for (let i = 1; i < recent.length; i += 1) {
    returns.push(returnBps(recent.slice(0, i + 1), 1));
  }
  if (returns.length === 0) {
    return 0;
  }
  const mean = average(returns);
  return Math.sqrt(average(returns.map((value) => (value - mean) ** 2)));
}

function dojiRate(bars: Array<{ open: number; high: number; low: number; close: number }>, lookback: number): number {
  const recent = bars.slice(-lookback);
  if (recent.length === 0) {
    return 0;
  }
  return recent.filter((bar) => {
    const range = Math.max(0.0001, bar.high - bar.low);
    return Math.abs(bar.close - bar.open) / range <= 0.25;
  }).length / recent.length;
}

function vwapCrossCount(closes: number[], vwaps: number[], lookback: number): number {
  const start = Math.max(0, closes.length - lookback);
  let crosses = 0;
  let previous = 0;
  for (let i = start; i < closes.length; i += 1) {
    const side = closes[i] > vwaps[i] ? 1 : closes[i] < vwaps[i] ? -1 : 0;
    if (side !== 0 && previous !== 0 && side !== previous) {
      crosses += 1;
    }
    if (side !== 0) {
      previous = side;
    }
  }
  return crosses;
}

function alternatingBarRate(values: number[], lookback: number): number {
  const recent = values.slice(-(lookback + 1));
  if (recent.length < 3) {
    return 0;
  }
  const directions: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    directions.push(Math.sign(recent[i] - recent[i - 1]));
  }
  let alternations = 0;
  let comparisons = 0;
  for (let i = 1; i < directions.length; i += 1) {
    if (directions[i] === 0 || directions[i - 1] === 0) {
      continue;
    }
    comparisons += 1;
    if (directions[i] !== directions[i - 1]) {
      alternations += 1;
    }
  }
  return comparisons === 0 ? 0 : alternations / comparisons;
}

function higherLowCount(lows: number[], lookback: number): number {
  const recent = lows.slice(-lookback);
  let count = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i] > recent[i - 1]) {
      count += 1;
    }
  }
  return count;
}

function lowerHighCount(highs: number[], lookback: number): number {
  const recent = highs.slice(-lookback);
  let count = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i] < recent[i - 1]) {
      count += 1;
    }
  }
  return count;
}

function relativeVolume(volumes: number[]): number {
  const latest = last(volumes) ?? 0;
  const prior = volumes.slice(-21, -1).filter((volume) => volume > 0);
  const baseline = average(prior);
  return baseline > 0 ? latest / baseline : 1;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
