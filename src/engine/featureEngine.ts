import type { AppConfig } from "../config/config";
import type { LiveState } from "../domain/state";
import { optionMid } from "../domain/types";
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
}
