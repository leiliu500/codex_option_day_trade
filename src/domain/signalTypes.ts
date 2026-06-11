import type { MarketRegime, RegimeFeatureSnapshot } from "./regimeTypes";

export type SetupType =
  | "ORB_CONTINUATION"
  | "VWAP_PULLBACK"
  | "EMA9_PULLBACK"
  | "EMA21_GRIND_CONTINUATION"
  | "MICRO_RANGE_BREAK"
  | "HIGHER_LOW_BREAK"
  | "LOWER_HIGH_BREAK"
  | "TREND_ACCELERATION"
  | "VWAP_RECLAIM_REVERSAL"
  | "VWAP_REJECT_REVERSAL"
  | "FAILED_BREAKOUT_REVERSAL"
  | "FAILED_BREAKDOWN_REVERSAL"
  | "GAP_AND_GO"
  | "CHOP_BREAKOUT";

export interface SignalCandidate {
  id: string;
  timestamp: string;
  underlying: string;
  direction: "BULLISH" | "BEARISH";
  regime: MarketRegime;
  setupType: SetupType;
  score: number;
  confidence: number;
  triggerPrice: number;
  invalidationPrice: number;
  stopBps: number;
  targetBps: number;
  maxHoldSeconds: number;
  allowEarlyEntry: boolean;
  needsConfirmationBars: number;
  reasons: string[];
  blockers: string[];
  featureSnapshot: RegimeFeatureSnapshot;
}
