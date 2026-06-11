import type { AppConfig } from "../config/config";
import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventEnvelope, TradeAction } from "../domain/types";
import { optionMid } from "../domain/types";
import type { ExecutionAdapter } from "./protocols";

export class SimulatedExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly config: AppConfig) {}

  async submitOrder(action: TradeAction, state: LiveState, nowIso: string, eventFactory: EventFactory): Promise<EventEnvelope[]> {
    const leg = action.legs[0];
    const quote = state.optionQuotes.get(leg.symbol);
    const events: EventEnvelope[] = [
      eventFactory.next(
        "trade_update",
        "replay",
        {
          client_order_id: action.client_order_id,
          action_id: action.action_id,
          status: "new",
          symbol: leg.symbol,
          underlying_symbol: action.underlying_symbol,
          side: leg.side,
          qty: action.qty,
          limit_price: action.limit_price,
          position_intent: leg.position_intent,
        },
        { symbol: leg.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
      ),
    ];
    if (quote && shouldFill(this.config.replay.fill_model, action, quote)) {
      const price = fillPrice(this.config.replay.fill_model, action, quote);
      events.push(
        eventFactory.next(
          "trade_update",
          "replay",
          {
            client_order_id: action.client_order_id,
            action_id: action.action_id,
            status: "filled",
            symbol: leg.symbol,
            underlying_symbol: action.underlying_symbol,
            side: leg.side,
            qty: action.qty,
            filled_qty: action.qty,
            fill_price: price,
            limit_price: action.limit_price,
            position_intent: leg.position_intent,
          },
          { symbol: leg.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
        ),
      );
    }
    return events;
  }
}

function shouldFill(fillModel: AppConfig["replay"]["fill_model"], action: TradeAction, quote: NonNullable<ReturnType<LiveState["optionQuotes"]["get"]>>): boolean {
  if (fillModel === "no_fill" || action.limit_price === undefined) {
    return false;
  }
  const mid = optionMid(quote);
  if (mid === undefined || quote.bid === undefined || quote.ask === undefined) {
    return false;
  }
  const side = action.legs[0].side;
  if (fillModel === "optimistic_mid") {
    return side === "buy" ? action.limit_price >= mid : action.limit_price <= mid;
  }
  return side === "buy" ? action.limit_price >= quote.ask : action.limit_price <= quote.bid;
}

function fillPrice(fillModel: AppConfig["replay"]["fill_model"], action: TradeAction, quote: NonNullable<ReturnType<LiveState["optionQuotes"]["get"]>>): number {
  const mid = optionMid(quote) ?? action.limit_price ?? 0;
  if (fillModel === "optimistic_mid") {
    return mid;
  }
  return action.legs[0].side === "buy" ? quote.ask ?? mid : quote.bid ?? mid;
}
