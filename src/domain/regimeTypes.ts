export enum MarketRegime {
  STRONG_UP = "STRONG_UP",
  STRONG_DOWN = "STRONG_DOWN",
  GRIND_UP = "GRIND_UP",
  GRIND_DOWN = "GRIND_DOWN",
  CHOP_DOJI = "CHOP_DOJI",
  HIGH_VOL_WHIPSAW = "HIGH_VOL_WHIPSAW",
  REVERSAL_UP = "REVERSAL_UP",
  REVERSAL_DOWN = "REVERSAL_DOWN",
  GAP_AND_GO_UP = "GAP_AND_GO_UP",
  GAP_AND_GO_DOWN = "GAP_AND_GO_DOWN",
  GAP_FADE_UP = "GAP_FADE_UP",
  GAP_FADE_DOWN = "GAP_FADE_DOWN",
  WIDE_DIRECTIONAL_UP = "WIDE_DIRECTIONAL_UP",
  WIDE_DIRECTIONAL_DOWN = "WIDE_DIRECTIONAL_DOWN",
  COMPRESSION = "COMPRESSION",
  UNKNOWN = "UNKNOWN",
}

export type TradeDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface RegimeFeatureSnapshot {
  price: number;
  vwap: number;
  ema9: number;
  ema21: number;
  ema50: number;
  priceToVwapBps: number;
  openingRangeHigh: number;
  openingRangeLow: number;
  openingRangeMid: number;
  openingRangeBps: number;
  priceToOrHighBps: number;
  priceToOrLowBps: number;
  gapBps: number;
  gapFillPct: number;
  ema9Slope1m: number;
  ema9Slope3m: number;
  ema21Slope3m: number;
  vwapSlope3m: number;
  ema9Acceleration: number;
  regressionSlope: number;
  ema9SlopeBpsPerMin: number;
  ema21SlopeBpsPerMin: number;
  ema50SlopeBpsPerMin: number;
  vwapSlopeBpsPerMin: number;
  ema9AccelerationBps: number;
  ema21AccelerationBps: number;
  regressionSlopeBpsPerMin: number;
  regressionR2: number;
  trendEfficiency10: number;
  trendEfficiency20: number;
  realizedVolBps1m: number;
  atrBps1m: number;
  rangeExpansionRatio: number;
  candleBodyPct: number;
  wickPct: number;
  dojiRate10: number;
  vwapCrossCount10: number;
  alternatingBarRate10: number;
  higherLowCount: number;
  lowerHighCount: number;
  pullbackDepthBps: number;
  returnBps1m: number;
  returnBps3m: number;
  returnBps5m: number;
  shortMomentumBps: number;
  momentumAccelerationBps: number;
  relativeVolume: number;
  priorHigh1m: number;
  priorLow1m: number;
  priorHigh3m: number;
  priorLow3m: number;
  compressionRangeBps: number;
}

export interface RegimeSnapshot {
  regime: MarketRegime;
  direction: TradeDirection;
  confidence: number;
  tradable: boolean;
  reasons: string[];
  blockers: string[];
  features: RegimeFeatureSnapshot;
}
