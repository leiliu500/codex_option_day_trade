import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventStore } from "../data/eventStore";
import type { MarketDataAdapter } from "../broker/protocols";

export class SnapshotRefresher {
  constructor(
    private readonly marketData: MarketDataAdapter,
    private readonly eventFactory: EventFactory,
    private readonly eventStore: EventStore,
  ) {}

  async refreshUnderlying(state: LiveState, underlying: string, nowIso: string): Promise<number> {
    const snapshots = await this.marketData.getOptionSnapshots(underlying);
    let count = 0;
    for (const [symbol, raw] of Object.entries(snapshots)) {
      const normalized = normalizeSnapshot(symbol, raw as Record<string, unknown>);
      const event = this.eventFactory.next("option_snapshot", "alpaca_rest", normalized, {
        raw: raw as Record<string, unknown>,
        symbol,
        received_at_utc: nowIso,
      });
      this.eventStore.append(event);
      state.applyEvent(event);
      count += 1;
    }
    return count;
  }
}

function normalizeSnapshot(symbol: string, raw: Record<string, unknown>): Record<string, unknown> {
  const latestQuote = (raw.latestQuote ?? raw.latest_quote ?? {}) as Record<string, unknown>;
  const latestTrade = (raw.latestTrade ?? raw.latest_trade ?? {}) as Record<string, unknown>;
  const greeks = (raw.greeks ?? {}) as Record<string, unknown>;
  return {
    symbol,
    bid: latestQuote.bp ?? latestQuote.bid_price ?? latestQuote.bid,
    ask: latestQuote.ap ?? latestQuote.ask_price ?? latestQuote.ask,
    bid_size: latestQuote.bs ?? latestQuote.bid_size,
    ask_size: latestQuote.as ?? latestQuote.ask_size,
    last_trade_price: latestTrade.p ?? latestTrade.price,
    last_trade_size: latestTrade.s ?? latestTrade.size,
    implied_volatility: raw.impliedVolatility ?? raw.implied_volatility,
    delta: greeks.delta,
    gamma: greeks.gamma,
    theta: greeks.theta,
    vega: greeks.vega,
  };
}
