import type { AppConfig } from "../config/config";
import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventStore } from "../data/eventStore";
import type { MarketDataAdapter } from "../broker/protocols";

export class SnapshotRefresher {
  constructor(
    private readonly config: AppConfig,
    private readonly marketData: MarketDataAdapter,
    private readonly eventFactory: EventFactory,
    private readonly eventStore: EventStore,
  ) {}

  async refreshUnderlying(state: LiveState, underlying: string, nowIso: string): Promise<number> {
    const symbols = [...state.contracts.values()]
      .filter((contract) => contract.underlying_symbol === underlying)
      .map((contract) => contract.symbol)
      .slice(0, this.config.universe.max_contracts_per_underlying);
    return this.refreshSymbols(state, underlying, symbols, nowIso);
  }

  async refreshSymbols(state: LiveState, underlying: string, symbols: string[], nowIso: string): Promise<number> {
    const selectedSymbols = normalizeSelectedSymbols(symbols, this.config.universe.max_contracts_per_underlying);
    if (selectedSymbols.length === 0) {
      return 0;
    }
    const snapshots = await this.marketData.getOptionSnapshots(underlying, selectedSymbols);
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

function normalizeSelectedSymbols(symbols: string[], maxSymbols: number): string[] {
  const selectedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (selectedSymbols.some((symbol) => symbol === "*" || symbol.includes("*"))) {
    throw new Error("Wildcard option snapshot refresh is not allowed.");
  }
  if (selectedSymbols.length > maxSymbols) {
    throw new Error(`Refusing to refresh ${selectedSymbols.length} option snapshots; max is ${maxSymbols}.`);
  }
  return selectedSymbols;
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
