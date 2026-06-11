import type { AppConfig } from "../config/config";
import type { MarketDataAdapter } from "../broker/protocols";
import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventStore } from "../data/eventStore";
import type { OptionContract } from "../domain/types";

export class UniverseBuilder {
  constructor(
    private readonly config: AppConfig,
    private readonly marketData: MarketDataAdapter,
    private readonly eventFactory: EventFactory,
    private readonly eventStore: EventStore,
  ) {}

  async refreshForUnderlying(state: LiveState, underlying: string, nowIso: string): Promise<OptionContract[]> {
    const price = state.underlyings.get(underlying)?.last_price;
    if (price === undefined) {
      throw new Error(`Cannot build option universe for ${underlying}: missing underlying price.`);
    }
    const minStrike = price * (1 - this.config.universe.strike_window_pct);
    const maxStrike = price * (1 + this.config.universe.strike_window_pct);
    const contracts: OptionContract[] = [];
    for (const right of ["call", "put"] as const) {
      if (right === "call" && !this.config.universe.include_calls) continue;
      if (right === "put" && !this.config.universe.include_puts) continue;
      contracts.push(
        ...(await this.marketData.getOptionContracts({
          underlying,
          right,
          strikePriceGte: minStrike,
          strikePriceLte: maxStrike,
        })),
      );
    }
    const sliced = contracts.slice(0, this.config.universe.max_contracts_per_underlying);
    for (const contract of sliced) {
      const event = this.eventFactory.next(
        "option_contract",
        "alpaca_rest",
        contract as unknown as Record<string, unknown>,
        { symbol: contract.symbol, received_at_utc: nowIso, raw: contract.raw ?? {} },
      );
      this.eventStore.append(event);
      state.applyEvent(event);
    }
    return sliced;
  }
}
