import type { AppConfig } from "../config/config";
import { MarketRegime, type RegimeFeatureSnapshot, type RegimeSnapshot, type TradeDirection } from "./regimeTypes";

export class RegimeEngine {
  constructor(private readonly config: AppConfig) {}

  classify(features: RegimeFeatureSnapshot): RegimeSnapshot {
    if (this.isGapAndGoUp(features)) {
      return this.snapshot(MarketRegime.GAP_AND_GO_UP, "BULLISH", 0.82, true, features, ["gap_hold_up"], []);
    }
    if (this.isGapAndGoDown(features)) {
      return this.snapshot(MarketRegime.GAP_AND_GO_DOWN, "BEARISH", 0.82, true, features, ["gap_hold_down"], []);
    }
    if (this.isHighVolWhipsaw(features)) {
      return this.snapshot(
        MarketRegime.HIGH_VOL_WHIPSAW,
        "NEUTRAL",
        0.78,
        false,
        features,
        ["wide_fast_two_sided_trade"],
        ["high_vol_whipsaw_requires_confirmation"],
      );
    }
    if (this.isChopDoji(features)) {
      return this.snapshot(
        MarketRegime.CHOP_DOJI,
        "NEUTRAL",
        0.76,
        false,
        features,
        ["flat_choppy_price_action"],
        ["regime_chop_no_edge"],
      );
    }
    if (this.isStrongUp(features)) {
      return this.snapshot(MarketRegime.STRONG_UP, "BULLISH", 0.84, true, features, ["strong_uptrend_alignment"], []);
    }
    if (this.isStrongDown(features)) {
      return this.snapshot(MarketRegime.STRONG_DOWN, "BEARISH", 0.84, true, features, ["strong_downtrend_alignment"], []);
    }
    if (this.isWideDirectionalUp(features)) {
      return this.snapshot(MarketRegime.WIDE_DIRECTIONAL_UP, "BULLISH", 0.8, true, features, ["wide_directional_up"], []);
    }
    if (this.isWideDirectionalDown(features)) {
      return this.snapshot(MarketRegime.WIDE_DIRECTIONAL_DOWN, "BEARISH", 0.8, true, features, ["wide_directional_down"], []);
    }
    if (this.isGrindUp(features)) {
      return this.snapshot(MarketRegime.GRIND_UP, "BULLISH", 0.76, true, features, ["grind_up_structure"], []);
    }
    if (this.isGrindDown(features)) {
      return this.snapshot(MarketRegime.GRIND_DOWN, "BEARISH", 0.76, true, features, ["grind_down_structure"], []);
    }
    if (this.isReversalUp(features)) {
      return this.snapshot(MarketRegime.REVERSAL_UP, "BULLISH", 0.78, true, features, ["failed_breakdown_reclaim"], []);
    }
    if (this.isReversalDown(features)) {
      return this.snapshot(MarketRegime.REVERSAL_DOWN, "BEARISH", 0.78, true, features, ["failed_breakout_loss"], []);
    }
    if (features.compressionRangeBps <= this.config.regime.grind.micro_range_bps && features.trendEfficiency10 < 0.35) {
      return this.snapshot(MarketRegime.COMPRESSION, "NEUTRAL", 0.65, false, features, ["compressed_range"], ["compression_wait_for_break"]);
    }
    return this.snapshot(MarketRegime.UNKNOWN, "NEUTRAL", 0.3, false, features, ["no_regime_match"], ["regime_unknown"]);
  }

  private isStrongUp(features: RegimeFeatureSnapshot): boolean {
    const { slope, strong, trend_quality } = this.config.regime;
    return (
      features.price > features.vwap &&
      features.priceToVwapBps >= 8 &&
      features.ema9SlopeBpsPerMin >= slope.strong_ema9_slope_bps_per_min &&
      features.ema21SlopeBpsPerMin >= slope.strong_ema21_slope_bps_per_min &&
      features.vwapSlopeBpsPerMin >= 0 &&
      features.ema9AccelerationBps >= -0.5 &&
      features.trendEfficiency10 >= trend_quality.strong_trend_efficiency10 &&
      features.regressionR2 >= trend_quality.min_regression_r2_strong &&
      features.vwapCrossCount10 <= 1 &&
      (features.higherLowCount >= 2 ||
        (features.shortMomentumBps >= strong.min_short_momentum_bps &&
          features.priceToOrHighBps >= Math.max(4, this.config.strategy.min_breakout_bps - 2)))
    );
  }

  private isStrongDown(features: RegimeFeatureSnapshot): boolean {
    const { slope, strong, trend_quality } = this.config.regime;
    return (
      features.price < features.vwap &&
      features.priceToVwapBps <= -8 &&
      features.ema9SlopeBpsPerMin <= -slope.strong_ema9_slope_bps_per_min &&
      features.ema21SlopeBpsPerMin <= -slope.strong_ema21_slope_bps_per_min &&
      features.vwapSlopeBpsPerMin <= 0 &&
      features.ema9AccelerationBps <= 0.5 &&
      features.trendEfficiency10 >= trend_quality.strong_trend_efficiency10 &&
      features.regressionR2 >= trend_quality.min_regression_r2_strong &&
      features.vwapCrossCount10 <= 1 &&
      (features.lowerHighCount >= 2 ||
        (features.shortMomentumBps <= -strong.min_short_momentum_bps &&
          -features.priceToOrLowBps >= Math.max(4, this.config.strategy.min_breakout_bps - 2)))
    );
  }

  private isGrindUp(features: RegimeFeatureSnapshot): boolean {
    const { grind, slope, trend_quality } = this.config.regime;
    return (
      features.price > features.vwap &&
      features.priceToVwapBps >= 3 &&
      features.vwapSlopeBpsPerMin >= slope.grind_vwap_slope_bps_per_min &&
      features.ema21SlopeBpsPerMin >= slope.grind_ema21_slope_bps_per_min &&
      features.ema9SlopeBpsPerMin >= slope.grind_ema9_slope_bps_per_min &&
      features.trendEfficiency20 >= trend_quality.grind_trend_efficiency20 &&
      features.regressionR2 >= trend_quality.min_regression_r2_grind &&
      features.realizedVolBps1m <= grind.normal_vol_ceiling_bps &&
      features.vwapCrossCount10 <= 2 &&
      features.higherLowCount >= grind.min_higher_low_count &&
      features.pullbackDepthBps <= grind.max_pullback_depth_bps
    );
  }

  private isGrindDown(features: RegimeFeatureSnapshot): boolean {
    const { grind, slope, trend_quality } = this.config.regime;
    return (
      features.price < features.vwap &&
      features.priceToVwapBps <= -3 &&
      features.vwapSlopeBpsPerMin <= -slope.grind_vwap_slope_bps_per_min &&
      features.ema21SlopeBpsPerMin <= -slope.grind_ema21_slope_bps_per_min &&
      features.ema9SlopeBpsPerMin <= -slope.grind_ema9_slope_bps_per_min &&
      features.trendEfficiency20 >= trend_quality.grind_trend_efficiency20 &&
      features.regressionR2 >= trend_quality.min_regression_r2_grind &&
      features.realizedVolBps1m <= grind.normal_vol_ceiling_bps &&
      features.vwapCrossCount10 <= 2 &&
      features.lowerHighCount >= grind.min_lower_high_count &&
      features.pullbackDepthBps <= grind.max_pullback_depth_bps
    );
  }

  private isChopDoji(features: RegimeFeatureSnapshot): boolean {
    const { chop, slope, trend_quality } = this.config.regime;
    return (
      Math.abs(features.vwapSlopeBpsPerMin) < chop.max_flat_vwap_slope_bps_per_min &&
      Math.abs(features.ema21SlopeBpsPerMin) < slope.flat_slope_abs_bps_per_min + 0.1 &&
      features.trendEfficiency10 < trend_quality.chop_trend_efficiency10 &&
      features.regressionR2 < 0.25 &&
      features.vwapCrossCount10 >= chop.min_vwap_cross_count10 &&
      (features.alternatingBarRate10 >= chop.min_alternating_bar_rate10 || features.dojiRate10 >= chop.min_doji_rate10) &&
      Math.abs(features.priceToVwapBps) <= 5
    );
  }

  private isHighVolWhipsaw(features: RegimeFeatureSnapshot): boolean {
    const { whipsaw, opening_range } = this.config.regime;
    return (
      (features.openingRangeBps > opening_range.old_soft_limit_bps || features.rangeExpansionRatio >= whipsaw.min_range_expansion_ratio) &&
      features.vwapCrossCount10 >= whipsaw.min_vwap_cross_count10 &&
      features.alternatingBarRate10 >= 0.45 &&
      features.trendEfficiency10 < whipsaw.max_trend_efficiency10
    );
  }

  private isReversalUp(features: RegimeFeatureSnapshot): boolean {
    return (
      features.price > features.openingRangeMid &&
      features.priceToOrLowBps > 0 &&
      features.priceToOrHighBps <= 25 &&
      features.ema21SlopeBpsPerMin <= 0.2 &&
      features.regressionSlopeBpsPerMin <= 0.5 &&
      features.trendEfficiency10 < this.config.regime.trend_quality.strong_trend_efficiency10 &&
      features.ema9AccelerationBps > 0 &&
      features.returnBps1m > 0 &&
      features.wickPct >= 0.4 &&
      features.higherLowCount >= 1
    );
  }

  private isReversalDown(features: RegimeFeatureSnapshot): boolean {
    return (
      features.price < features.openingRangeMid &&
      features.priceToOrHighBps < 0 &&
      features.priceToOrLowBps >= -25 &&
      features.ema21SlopeBpsPerMin >= -0.2 &&
      features.regressionSlopeBpsPerMin >= -0.5 &&
      features.trendEfficiency10 < this.config.regime.trend_quality.strong_trend_efficiency10 &&
      features.ema9AccelerationBps < 0 &&
      features.returnBps1m < 0 &&
      features.wickPct >= 0.4 &&
      features.lowerHighCount >= 1
    );
  }

  private isGapAndGoUp(features: RegimeFeatureSnapshot): boolean {
    const { gap } = this.config.regime;
    return (
      features.gapBps >= gap.min_gap_bps &&
      features.gapFillPct <= gap.max_gap_fill_pct_for_gap_and_go &&
      features.price > features.vwap &&
      features.vwapSlopeBpsPerMin > 0 &&
      features.ema9SlopeBpsPerMin > 0 &&
      features.relativeVolume >= gap.min_relative_volume
    );
  }

  private isGapAndGoDown(features: RegimeFeatureSnapshot): boolean {
    const { gap } = this.config.regime;
    return (
      features.gapBps <= -gap.min_gap_bps &&
      features.gapFillPct <= gap.max_gap_fill_pct_for_gap_and_go &&
      features.price < features.vwap &&
      features.vwapSlopeBpsPerMin < 0 &&
      features.ema9SlopeBpsPerMin < 0 &&
      features.relativeVolume >= gap.min_relative_volume
    );
  }

  private isWideDirectionalUp(features: RegimeFeatureSnapshot): boolean {
    return (
      this.config.regime.opening_range.allow_wide_directional &&
      features.openingRangeBps > this.config.regime.opening_range.old_soft_limit_bps &&
      features.price > features.vwap &&
      features.trendEfficiency10 >= 0.5 &&
      features.vwapSlopeBpsPerMin > 0 &&
      features.ema21SlopeBpsPerMin > 0 &&
      features.vwapCrossCount10 <= 1
    );
  }

  private isWideDirectionalDown(features: RegimeFeatureSnapshot): boolean {
    return (
      this.config.regime.opening_range.allow_wide_directional &&
      features.openingRangeBps > this.config.regime.opening_range.old_soft_limit_bps &&
      features.price < features.vwap &&
      features.trendEfficiency10 >= 0.5 &&
      features.vwapSlopeBpsPerMin < 0 &&
      features.ema21SlopeBpsPerMin < 0 &&
      features.vwapCrossCount10 <= 1
    );
  }

  private snapshot(
    regime: MarketRegime,
    direction: TradeDirection,
    confidence: number,
    tradable: boolean,
    features: RegimeFeatureSnapshot,
    reasons: string[],
    blockers: string[],
  ): RegimeSnapshot {
    return { regime, direction, confidence, tradable, reasons, blockers, features };
  }
}
