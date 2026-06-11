import type { AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import type { ContractCandidate, OptionContract, OptionRight, Signal } from "../domain/types";
import { optionMid } from "../domain/types";
import { dateKeyDayDiff, etDateKey, secondsBetweenIso } from "../util/time";

export class ContractSelector {
  constructor(private readonly config: AppConfig) {}

  select(signal: Signal, state: LiveState, nowIso: string): ContractCandidate[] {
    const wantedRight: OptionRight | undefined =
      signal.direction === "bullish" ? "call" : signal.direction === "bearish" ? "put" : undefined;
    if (!wantedRight) {
      return [];
    }
    const candidates: ContractCandidate[] = [];
    for (const contract of state.contracts.values()) {
      if (contract.underlying_symbol !== signal.underlying_symbol || contract.right !== wantedRight) {
        continue;
      }
      const quote = state.optionQuotes.get(contract.symbol);
      if (!quote) {
        continue;
      }
      const evaluated = this.evaluate(contract, quote, nowIso);
      if (evaluated) {
        candidates.push(evaluated);
      }
    }
    return candidates.sort((a, b) => b.score - a.score || a.contract.symbol.localeCompare(b.contract.symbol));
  }

  private evaluate(
    contract: OptionContract,
    quote: NonNullable<ReturnType<LiveState["optionQuotes"]["get"]>>,
    nowIso: string,
  ): ContractCandidate | undefined {
    const mid = optionMid(quote);
    if (quote.bid === undefined || quote.bid < this.config.contract_selector.min_bid) {
      return undefined;
    }
    if (mid === undefined || mid < this.config.contract_selector.min_mid || mid > this.config.contract_selector.max_mid) {
      return undefined;
    }
    const spread = quote.ask! - quote.bid;
    const spreadPct = spread / mid;
    if (spreadPct > this.config.contract_selector.max_spread_pct_of_mid) {
      return undefined;
    }
    const quoteAge = secondsBetweenIso(quote.received_at_utc, nowIso);
    if (quoteAge > this.config.stream.max_quote_age_seconds) {
      return undefined;
    }
    if (quote.delta !== undefined) {
      const absDelta = Math.abs(quote.delta);
      if (absDelta < this.config.contract_selector.min_abs_delta || absDelta > this.config.contract_selector.max_abs_delta) {
        return undefined;
      }
    }
    if (
      contract.open_interest !== undefined &&
      contract.open_interest < this.config.contract_selector.min_open_interest
    ) {
      return undefined;
    }
    if (contract.status && contract.status !== "active") {
      return undefined;
    }
    if (!this.expirationInRange(contract.expiration_date, nowIso)) {
      return undefined;
    }

    const absDelta = quote.delta === undefined ? undefined : Math.abs(quote.delta);
    const score = this.score(absDelta, spreadPct, quoteAge, contract.open_interest, quote.theta);
    return {
      contract,
      quote,
      abs_delta: absDelta,
      spread,
      spread_pct_of_mid: spreadPct,
      quote_age_seconds: quoteAge,
      score,
      reason_codes: ["candidate_passed_filters"],
    };
  }

  private score(absDelta: number | undefined, spreadPct: number, quoteAge: number, openInterest = 0, theta = 0): number {
    const target = this.config.contract_selector.target_abs_delta;
    const deltaFit = absDelta === undefined ? 0.5 : 1 - Math.min(Math.abs(absDelta - target) / target, 1);
    const spreadQuality = 1 - Math.min(spreadPct / this.config.contract_selector.max_spread_pct_of_mid, 1);
    const freshness = 1 - Math.min(quoteAge / this.config.stream.max_quote_age_seconds, 1);
    const oiScore = Math.min(openInterest / 5000, 1);
    const thetaPenalty = Math.min(Math.abs(theta), 1);
    return 2 * deltaFit + 2 * spreadQuality + freshness + 0.5 * oiScore - 0.5 * thetaPenalty;
  }

  private expirationInRange(expirationDate: string, nowIso: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) {
      return false;
    }
    const nowEtDate = etDateKey(new Date(nowIso), this.config.system.timezone);
    const days = dateKeyDayDiff(nowEtDate, expirationDate);
    return days >= this.config.universe.dte_min && days <= this.config.universe.dte_max;
  }
}
