import { createHash } from "node:crypto";
import type { AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import type { Signal, SignalDirection } from "../domain/types";
import { MarketRegime, type RegimeSnapshot } from "../domain/regimeTypes";
import type { SetupType, SignalCandidate } from "../domain/signalTypes";
import { isEtBetween } from "../util/time";
import { FeatureEngine } from "./featureEngine";

export class SignalEngine {
  private readonly features: FeatureEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly runId: string,
  ) {
    this.features = new FeatureEngine(config);
  }

  evaluateEntry(state: LiveState, underlyingSymbol: string, nowIso: string): Signal {
    const now = new Date(nowIso);
    const feature = this.features.underlyingFeatures(state, underlyingSymbol, nowIso);
    const reasonCodes: string[] = [];
    let direction: SignalDirection = "none";
    let confidence = 0;

    if (!this.config.strategy.enabled) {
      reasonCodes.push("strategy_disabled");
    }
    if (!isEtBetween(now, this.config.session.first_entry_time_et, this.config.session.last_entry_time_et, this.config.system.timezone)) {
      reasonCodes.push("outside_entry_window");
    }
    if (feature.price === undefined) {
      reasonCodes.push("missing_underlying_price");
    }
    if (feature.vwap === undefined && this.config.strategy.require_vwap_alignment) {
      reasonCodes.push("missing_vwap");
    }
    if (feature.opening_range_high === undefined || feature.opening_range_low === undefined) {
      reasonCodes.push("missing_opening_range");
    }
    if (
      feature.opening_range_bps !== undefined &&
      this.config.strategy.max_opening_range_bps !== null &&
      feature.opening_range_bps > this.config.strategy.max_opening_range_bps
    ) {
      reasonCodes.push("opening_range_too_wide");
    }

    const canEvaluate =
      reasonCodes.length === 0 &&
      feature.price !== undefined &&
      feature.vwap !== undefined &&
      feature.opening_range_high !== undefined &&
      feature.opening_range_low !== undefined;

    if (canEvaluate) {
      const momentum = feature.short_momentum_bps;
      const bullishBreakoutBps = ((feature.price! - feature.opening_range_high!) / feature.opening_range_high!) * 10_000;
      const bearishBreakoutBps = ((feature.opening_range_low! - feature.price!) / feature.opening_range_low!) * 10_000;
      const vwapDistanceBps = ((feature.price! - feature.vwap!) / feature.vwap!) * 10_000;
      if (
        feature.price! > feature.vwap! &&
        feature.price! > feature.opening_range_high! &&
        bullishBreakoutBps >= this.config.strategy.min_breakout_bps &&
        vwapDistanceBps >= this.config.strategy.min_vwap_distance_bps &&
        momentum >= this.config.strategy.min_underlying_momentum_bps
      ) {
        direction = "bullish";
        reasonCodes.push("price_above_vwap", "opening_range_breakout_high", "positive_short_momentum", "breakout_confirmed");
        confidence = Math.min(0.95, 0.5 + Math.abs(momentum) / 800 + bullishBreakoutBps / 1000);
      } else if (
        feature.price! < feature.vwap! &&
        feature.price! < feature.opening_range_low! &&
        bearishBreakoutBps >= this.config.strategy.min_breakout_bps &&
        -vwapDistanceBps >= this.config.strategy.min_vwap_distance_bps &&
        momentum <= -this.config.strategy.min_underlying_momentum_bps
      ) {
        direction = "bearish";
        reasonCodes.push("price_below_vwap", "opening_range_breakout_low", "negative_short_momentum", "breakout_confirmed");
        confidence = Math.min(0.95, 0.5 + Math.abs(momentum) / 800 + bearishBreakoutBps / 1000);
      } else {
        reasonCodes.push("no_opening_range_breakout");
      }
    }

    return {
      signal_id: signalId(this.runId, underlyingSymbol, nowIso, direction, reasonCodes),
      run_id: this.runId,
      strategy_name: this.config.strategy.name,
      underlying_symbol: underlyingSymbol,
      direction,
      confidence,
      reason_codes: reasonCodes,
      features: feature as unknown as Record<string, unknown>,
      created_at_utc: nowIso,
    };
  }

  generateCandidates(regime: RegimeSnapshot, underlyingSymbol: string, _state: LiveState, nowIso: string): SignalCandidate[] {
    if (!this.config.strategy.enabled || !regime.tradable) {
      return [];
    }
    const features = regime.features;
    const candidates: SignalCandidate[] = [];
    switch (regime.regime) {
      case MarketRegime.STRONG_UP:
      case MarketRegime.WIDE_DIRECTIONAL_UP:
      case MarketRegime.GAP_AND_GO_UP:
        this.addBullishOrbOrTrendCandidates(candidates, regime, underlyingSymbol, nowIso);
        break;
      case MarketRegime.STRONG_DOWN:
      case MarketRegime.WIDE_DIRECTIONAL_DOWN:
      case MarketRegime.GAP_AND_GO_DOWN:
        this.addBearishOrbOrTrendCandidates(candidates, regime, underlyingSymbol, nowIso);
        break;
      case MarketRegime.GRIND_UP:
        this.addGrindUpCandidates(candidates, regime, underlyingSymbol, nowIso);
        break;
      case MarketRegime.GRIND_DOWN:
        this.addGrindDownCandidates(candidates, regime, underlyingSymbol, nowIso);
        break;
      case MarketRegime.REVERSAL_UP:
        this.addCandidate(candidates, regime, underlyingSymbol, "BULLISH", "VWAP_RECLAIM_REVERSAL", nowIso, [
          features.price > features.openingRangeMid,
          ["acceleration_too_low", features.ema9AccelerationBps > 0],
          features.returnBps1m > 0,
        ]);
        break;
      case MarketRegime.REVERSAL_DOWN:
        this.addCandidate(candidates, regime, underlyingSymbol, "BEARISH", "VWAP_REJECT_REVERSAL", nowIso, [
          features.price < features.openingRangeMid,
          ["acceleration_too_low", features.ema9AccelerationBps < 0],
          features.returnBps1m < 0,
        ]);
        break;
      default:
        break;
    }
    return candidates;
  }

  candidateToSignal(candidate: SignalCandidate): Signal {
    const direction: SignalDirection = candidate.direction === "BULLISH" ? "bullish" : "bearish";
    return {
      signal_id: candidate.id,
      run_id: this.runId,
      strategy_name: this.config.strategy.name,
      underlying_symbol: candidate.underlying,
      direction,
      confidence: candidate.confidence,
      reason_codes: [
        `regime_${candidate.regime}`,
        `setup_${candidate.setupType}`,
        ...candidate.reasons,
      ],
      features: candidate.featureSnapshot as unknown as Record<string, unknown>,
      created_at_utc: candidate.timestamp,
    };
  }

  private addBullishOrbOrTrendCandidates(candidates: SignalCandidate[], regime: RegimeSnapshot, underlyingSymbol: string, nowIso: string): void {
    const features = regime.features;
    this.addCandidate(candidates, regime, underlyingSymbol, "BULLISH", regime.regime === MarketRegime.GAP_AND_GO_UP ? "GAP_AND_GO" : "ORB_CONTINUATION", nowIso, [
      features.price > features.vwap,
      features.price > features.openingRangeHigh,
      features.priceToOrHighBps >= Math.max(4, this.config.strategy.min_breakout_bps - 2),
      ["slope_too_low", features.ema9SlopeBpsPerMin >= 2],
      ["slope_too_low", features.ema21SlopeBpsPerMin >= 0.8],
      features.trendEfficiency10 >= 0.5,
    ]);
    this.addCandidate(candidates, regime, underlyingSymbol, "BULLISH", "TREND_ACCELERATION", nowIso, [
      features.price > features.vwap,
      features.price >= features.ema9,
      ["acceleration_too_low", features.ema9AccelerationBps > 0],
      features.returnBps1m > features.returnBps3m / 3,
      features.price > features.priorHigh3m,
    ]);
  }

  private addBearishOrbOrTrendCandidates(candidates: SignalCandidate[], regime: RegimeSnapshot, underlyingSymbol: string, nowIso: string): void {
    const features = regime.features;
    this.addCandidate(candidates, regime, underlyingSymbol, "BEARISH", regime.regime === MarketRegime.GAP_AND_GO_DOWN ? "GAP_AND_GO" : "ORB_CONTINUATION", nowIso, [
      features.price < features.vwap,
      features.price < features.openingRangeLow,
      -features.priceToOrLowBps >= Math.max(4, this.config.strategy.min_breakout_bps - 2),
      ["slope_too_low", features.ema9SlopeBpsPerMin <= -2],
      ["slope_too_low", features.ema21SlopeBpsPerMin <= -0.8],
      features.trendEfficiency10 >= 0.5,
    ]);
    this.addCandidate(candidates, regime, underlyingSymbol, "BEARISH", "TREND_ACCELERATION", nowIso, [
      features.price < features.vwap,
      features.price <= features.ema9,
      ["acceleration_too_low", features.ema9AccelerationBps < 0],
      features.returnBps1m < features.returnBps3m / 3,
      features.price < features.priorLow3m,
    ]);
  }

  private addGrindUpCandidates(candidates: SignalCandidate[], regime: RegimeSnapshot, underlyingSymbol: string, nowIso: string): void {
    const features = regime.features;
    const grind = this.config.regime.grind;
    this.addCandidate(candidates, regime, underlyingSymbol, "BULLISH", "VWAP_PULLBACK", nowIso, [
      features.price > features.vwap,
      ["slope_too_low", features.vwapSlopeBpsPerMin >= this.config.regime.slope.grind_vwap_slope_bps_per_min],
      ["slope_too_low", features.ema21SlopeBpsPerMin >= this.config.regime.slope.grind_ema21_slope_bps_per_min],
      features.trendEfficiency20 >= this.config.regime.trend_quality.grind_trend_efficiency20,
      features.pullbackDepthBps <= grind.max_pullback_depth_bps,
      features.higherLowCount >= grind.min_higher_low_count,
      features.price > features.priorHigh1m || features.price > features.priorHigh3m,
    ]);
    this.addCandidate(candidates, regime, underlyingSymbol, "BULLISH", "EMA21_GRIND_CONTINUATION", nowIso, [
      features.price > features.ema21,
      ["slope_too_low", features.ema21SlopeBpsPerMin >= this.config.regime.slope.grind_ema21_slope_bps_per_min],
      features.higherLowCount >= grind.min_higher_low_count,
      features.vwapCrossCount10 <= 2,
      features.compressionRangeBps <= grind.micro_range_bps || features.price > features.priorHigh3m,
    ]);
    this.addCandidate(candidates, regime, underlyingSymbol, "BULLISH", "MICRO_RANGE_BREAK", nowIso, [
      features.compressionRangeBps <= grind.micro_range_bps,
      ["slope_too_low", features.vwapSlopeBpsPerMin > 0],
      ["slope_too_low", features.ema21SlopeBpsPerMin > 0],
      features.price > features.priorHigh3m,
      ["acceleration_too_low", features.ema9AccelerationBps > -0.2],
    ]);
  }

  private addGrindDownCandidates(candidates: SignalCandidate[], regime: RegimeSnapshot, underlyingSymbol: string, nowIso: string): void {
    const features = regime.features;
    const grind = this.config.regime.grind;
    this.addCandidate(candidates, regime, underlyingSymbol, "BEARISH", "VWAP_PULLBACK", nowIso, [
      features.price < features.vwap,
      ["slope_too_low", features.vwapSlopeBpsPerMin <= -this.config.regime.slope.grind_vwap_slope_bps_per_min],
      ["slope_too_low", features.ema21SlopeBpsPerMin <= -this.config.regime.slope.grind_ema21_slope_bps_per_min],
      features.trendEfficiency20 >= this.config.regime.trend_quality.grind_trend_efficiency20,
      features.pullbackDepthBps <= grind.max_pullback_depth_bps,
      features.lowerHighCount >= grind.min_lower_high_count,
      features.price < features.priorLow1m || features.price < features.priorLow3m,
    ]);
    this.addCandidate(candidates, regime, underlyingSymbol, "BEARISH", "EMA21_GRIND_CONTINUATION", nowIso, [
      features.price < features.ema21,
      ["slope_too_low", features.ema21SlopeBpsPerMin <= -this.config.regime.slope.grind_ema21_slope_bps_per_min],
      features.lowerHighCount >= grind.min_lower_high_count,
      features.vwapCrossCount10 <= 2,
      features.compressionRangeBps <= grind.micro_range_bps || features.price < features.priorLow3m,
    ]);
    this.addCandidate(candidates, regime, underlyingSymbol, "BEARISH", "MICRO_RANGE_BREAK", nowIso, [
      features.compressionRangeBps <= grind.micro_range_bps,
      ["slope_too_low", features.vwapSlopeBpsPerMin < 0],
      ["slope_too_low", features.ema21SlopeBpsPerMin < 0],
      features.price < features.priorLow3m,
      ["acceleration_too_low", features.ema9AccelerationBps < 0.2],
    ]);
  }

  private addCandidate(
    candidates: SignalCandidate[],
    regime: RegimeSnapshot,
    underlyingSymbol: string,
    direction: "BULLISH" | "BEARISH",
    setupType: SetupType,
    nowIso: string,
    checks: Array<boolean | [string, boolean]>,
  ): void {
    const blockers = [
      ...new Set(
        checks
          .map((check, index) => {
            const [reason, passed] = Array.isArray(check) ? check : [`setup_check_${index + 1}_failed`, check];
            return passed ? "" : reason;
          })
          .filter(Boolean),
      ),
    ];
    const features = regime.features;
    const score = this.score(regime, setupType, blockers.length);
    candidates.push({
      id: signalId(this.runId, regime.features.price.toString(), nowIso, direction === "BULLISH" ? "bullish" : "bearish", [
        regime.regime,
        setupType,
      ]),
      timestamp: nowIso,
      underlying: underlyingSymbol,
      direction,
      regime: regime.regime,
      setupType,
      score,
      confidence: regime.confidence,
      triggerPrice: features.price,
      invalidationPrice:
        direction === "BULLISH"
          ? Math.min(features.vwap, features.ema21, features.openingRangeMid)
          : Math.max(features.vwap, features.ema21, features.openingRangeMid),
      stopBps: setupType.includes("GRIND") || regime.regime === MarketRegime.GRIND_UP || regime.regime === MarketRegime.GRIND_DOWN ? this.config.regime.grind.stop_pct * 10_000 : this.config.regime.strong.stop_pct * 10_000,
      targetBps: setupType.includes("GRIND") || regime.regime === MarketRegime.GRIND_UP || regime.regime === MarketRegime.GRIND_DOWN ? this.config.regime.grind.target_pct * 10_000 : this.config.regime.strong.target_pct * 10_000,
      maxHoldSeconds: regime.regime === MarketRegime.GRIND_UP || regime.regime === MarketRegime.GRIND_DOWN ? this.config.regime.grind.max_hold_seconds : this.config.regime.strong.max_hold_seconds,
      allowEarlyEntry: regime.regime === MarketRegime.GAP_AND_GO_UP || regime.regime === MarketRegime.GAP_AND_GO_DOWN || regime.confidence >= 0.8,
      needsConfirmationBars: regime.regime === MarketRegime.HIGH_VOL_WHIPSAW ? this.config.regime.whipsaw.require_confirmation_bars : 0,
      reasons: [regime.regime, setupType, ...regime.reasons],
      blockers,
      featureSnapshot: features,
    });
  }

  private score(regime: RegimeSnapshot, setupType: SetupType, blockerCount: number): number {
    const features = regime.features;
    const trendAlignment = Math.min(20, Math.max(0, Math.abs(features.priceToVwapBps)));
    const slope = Math.min(15, Math.abs(features.ema9SlopeBpsPerMin) * 3 + Math.abs(features.ema21SlopeBpsPerMin) * 4);
    const acceleration = Math.min(10, Math.abs(features.ema9AccelerationBps) * 5 + Math.abs(features.momentumAccelerationBps) * 0.5);
    const trigger = setupType === "ORB_CONTINUATION" ? Math.min(15, Math.abs(features.priceToOrHighBps || features.priceToOrLowBps)) : 12;
    const pullback = Math.max(0, 10 - Math.max(0, features.pullbackDepthBps - this.config.regime.grind.max_pullback_depth_bps) * 0.5);
    const penalties = blockerCount * 25 + (regime.regime === MarketRegime.HIGH_VOL_WHIPSAW ? 20 : 0) + (regime.regime === MarketRegime.CHOP_DOJI ? 30 : 0);
    return Math.max(0, Math.min(100, regime.confidence * 25 + trendAlignment + slope + acceleration + trigger + pullback - penalties));
  }
}

function signalId(runId: string, symbol: string, nowIso: string, direction: SignalDirection, reasons: string[]): string {
  return createHash("sha1").update([runId, symbol, nowIso, direction, ...reasons].join("|")).digest("hex");
}
