import { createHash } from "node:crypto";
import type { AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import type { Signal, SignalDirection } from "../domain/types";
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
}

function signalId(runId: string, symbol: string, nowIso: string, direction: SignalDirection, reasons: string[]): string {
  return createHash("sha1").update([runId, symbol, nowIso, direction, ...reasons].join("|")).digest("hex");
}
