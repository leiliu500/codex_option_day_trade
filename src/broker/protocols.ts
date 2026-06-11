import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventEnvelope, OptionContract, TradeAction } from "../domain/types";

export interface ExecutionAdapter {
  submitOrder(action: TradeAction, state: LiveState, nowIso: string, eventFactory: EventFactory): Promise<EventEnvelope[]>;
  cancelOrder?(clientOrderId: string, eventFactory: EventFactory): Promise<EventEnvelope[]>;
}

export interface MarketDataAdapter {
  getOptionContracts(params: {
    underlying: string;
    expirationDateGte?: string;
    expirationDateLte?: string;
    strikePriceGte?: number;
    strikePriceLte?: number;
    right?: "call" | "put";
  }): Promise<OptionContract[]>;
  getOptionSnapshots(underlying: string, symbols?: string[]): Promise<Record<string, unknown>>;
}

export interface TradingAdapter extends ExecutionAdapter {
  getAccount(): Promise<Record<string, unknown>>;
}
