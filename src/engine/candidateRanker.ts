import type { AppConfig } from "../config/config";
import { MarketRegime } from "../domain/regimeTypes";
import type { SignalCandidate } from "../domain/signalTypes";

export class CandidateRanker {
  constructor(private readonly config: AppConfig) {}

  rank(candidates: SignalCandidate[]): SignalCandidate[] {
    return this.annotate(candidates)
      .filter((candidate) => candidate.blockers.length === 0)
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.id.localeCompare(b.id));
  }

  annotate(candidates: SignalCandidate[]): SignalCandidate[] {
    return candidates.map((candidate) => ({
      ...candidate,
      blockers: [...new Set([...candidate.blockers, ...this.scoreBlockers(candidate)])],
    }));
  }

  private scoreBlockers(candidate: SignalCandidate): string[] {
    const minScore = this.minScore(candidate.regime);
    return candidate.score >= minScore ? [] : ["score_too_low"];
  }

  private minScore(regime: MarketRegime): number {
    const scores = this.config.regime.candidate_scores;
    switch (regime) {
      case MarketRegime.STRONG_UP:
      case MarketRegime.STRONG_DOWN:
        return scores.min_strong_score;
      case MarketRegime.GRIND_UP:
      case MarketRegime.GRIND_DOWN:
        return scores.min_grind_score;
      case MarketRegime.GAP_AND_GO_UP:
      case MarketRegime.GAP_AND_GO_DOWN:
        return scores.min_gap_and_go_score;
      case MarketRegime.REVERSAL_UP:
      case MarketRegime.REVERSAL_DOWN:
        return scores.min_reversal_score;
      case MarketRegime.WIDE_DIRECTIONAL_UP:
      case MarketRegime.WIDE_DIRECTIONAL_DOWN:
        return scores.min_wide_directional_score;
      case MarketRegime.CHOP_DOJI:
        return scores.min_chop_breakout_score;
      case MarketRegime.HIGH_VOL_WHIPSAW:
        return scores.min_whipsaw_reversal_score;
      default:
        return 100;
    }
  }
}
