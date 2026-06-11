import type {
  EventEnvelope,
  OptionContract,
  OptionQuoteState,
  OrderRecord,
  PositionState,
  StreamHealth,
  StrategyType,
  UnderlyingState,
} from "./types";
import { optionMid } from "./types";
import { zonedTimeToUtc } from "../util/time";
import type { AppConfig } from "../config/config";

interface PricePoint {
  at: string;
  price: number;
}

export class LiveState {
  readonly underlyings = new Map<string, UnderlyingState>();
  readonly optionQuotes = new Map<string, OptionQuoteState>();
  readonly contracts = new Map<string, OptionContract>();
  readonly orders = new Map<string, OrderRecord>();
  readonly positions = new Map<string, PositionState>();
  readonly streamHealth = new Map<string, StreamHealth>();
  readonly seenEventIds = new Set<string>();
  readonly priceHistory = new Map<string, PricePoint[]>();

  killSwitchEnabled = false;
  brokerReconciliationMismatch = false;
  dailyRealizedPnl = 0;
  tradesToday = 0;
  recentRejects = 0;

  constructor(private readonly config: AppConfig) {}

  applyEvent(event: EventEnvelope): boolean {
    if (this.seenEventIds.has(event.event_id)) {
      return false;
    }
    this.seenEventIds.add(event.event_id);
    switch (event.event_type) {
      case "underlying_quote":
      case "underlying_bar":
        this.applyUnderlying(event);
        break;
      case "option_contract":
        this.applyContract(event);
        break;
      case "option_quote":
      case "option_snapshot":
      case "option_trade":
        this.applyOptionQuote(event);
        break;
      case "stream_health":
        this.applyStreamHealth(event);
        break;
      case "risk_state":
        this.applyRiskState(event);
        break;
      case "order_submitted":
        this.applyOrderSubmitted(event);
        break;
      case "trade_update":
      case "fill":
        this.applyTradeUpdate(event);
        break;
      case "reconciliation":
        this.brokerReconciliationMismatch = Boolean(event.normalized.mismatch);
        break;
      default:
        break;
    }
    return true;
  }

  getOpenOrders(): OrderRecord[] {
    return [...this.orders.values()].filter((order) =>
      ["submitted", "new", "partially_filled", "cancel_requested", "replace_requested", "replaced"].includes(order.status),
    );
  }

  getOpenPositions(): PositionState[] {
    return [...this.positions.values()].filter((position) => position.status === "open" || position.status === "closing");
  }

  getMomentumBps(symbol: string, nowIso: string, windowSeconds = 60): number {
    const history = this.priceHistory.get(symbol) ?? [];
    const nowMs = Date.parse(nowIso);
    const recent = history.filter((point) => nowMs - Date.parse(point.at) <= windowSeconds * 1000);
    if (recent.length < 2) {
      return 0;
    }
    const first = recent[0].price;
    const last = recent[recent.length - 1].price;
    return ((last - first) / first) * 10_000;
  }

  private applyUnderlying(event: EventEnvelope): void {
    const symbol = String(event.normalized.symbol ?? event.symbol ?? "").toUpperCase();
    if (!symbol) {
      return;
    }
    const current = this.underlyings.get(symbol) ?? { symbol };
    const lastPrice = numberOrUndefined(event.normalized.last_price ?? event.normalized.close ?? event.normalized.price);
    const next: UnderlyingState = {
      ...current,
      last_price: lastPrice ?? current.last_price,
      bid: numberOrUndefined(event.normalized.bid) ?? current.bid,
      ask: numberOrUndefined(event.normalized.ask) ?? current.ask,
      vwap: numberOrUndefined(event.normalized.vwap) ?? current.vwap,
      opening_range_high: numberOrUndefined(event.normalized.opening_range_high) ?? current.opening_range_high,
      opening_range_low: numberOrUndefined(event.normalized.opening_range_low) ?? current.opening_range_low,
      last_event_at_utc: event.event_at_utc ?? event.received_at_utc,
      last_received_at_utc: event.received_at_utc,
    };
    if (next.last_price !== undefined) {
      next.session_high = Math.max(next.last_price, current.session_high ?? Number.NEGATIVE_INFINITY);
      next.session_low = Math.min(next.last_price, current.session_low ?? Number.POSITIVE_INFINITY);
      const history = this.priceHistory.get(symbol) ?? [];
      history.push({ at: event.received_at_utc, price: next.last_price });
      this.priceHistory.set(
        symbol,
        history.filter((point) => Date.parse(event.received_at_utc) - Date.parse(point.at) <= 30 * 60 * 1000),
      );
    }
    this.underlyings.set(symbol, next);
  }

  private applyContract(event: EventEnvelope): void {
    const contract = event.normalized as unknown as OptionContract;
    if (!contract.symbol) {
      return;
    }
    this.contracts.set(contract.symbol, {
      ...contract,
      symbol: contract.symbol,
      underlying_symbol: contract.underlying_symbol.toUpperCase(),
    });
  }

  private applyOptionQuote(event: EventEnvelope): void {
    const symbol = String(event.normalized.symbol ?? event.symbol ?? "").toUpperCase();
    if (!symbol) {
      return;
    }
    const current = this.optionQuotes.get(symbol) ?? { symbol };
    const next: OptionQuoteState = {
      ...current,
      bid: numberOrUndefined(event.normalized.bid) ?? current.bid,
      ask: numberOrUndefined(event.normalized.ask) ?? current.ask,
      bid_size: numberOrUndefined(event.normalized.bid_size) ?? current.bid_size,
      ask_size: numberOrUndefined(event.normalized.ask_size) ?? current.ask_size,
      last_trade_price: numberOrUndefined(event.normalized.last_trade_price ?? event.normalized.price) ?? current.last_trade_price,
      last_trade_size: numberOrUndefined(event.normalized.last_trade_size ?? event.normalized.size) ?? current.last_trade_size,
      quote_event_at_utc: event.event_type === "option_trade" ? current.quote_event_at_utc : event.event_at_utc ?? event.received_at_utc,
      trade_event_at_utc: event.event_type === "option_trade" ? event.event_at_utc ?? event.received_at_utc : current.trade_event_at_utc,
      received_at_utc: event.received_at_utc,
      implied_volatility: numberOrUndefined(event.normalized.implied_volatility) ?? current.implied_volatility,
      delta: numberOrUndefined(event.normalized.delta) ?? current.delta,
      gamma: numberOrUndefined(event.normalized.gamma) ?? current.gamma,
      theta: numberOrUndefined(event.normalized.theta) ?? current.theta,
      vega: numberOrUndefined(event.normalized.vega) ?? current.vega,
      snapshot_at_utc: event.event_type === "option_snapshot" ? event.received_at_utc : current.snapshot_at_utc,
    };
    this.optionQuotes.set(symbol, next);
  }

  private applyStreamHealth(event: EventEnvelope): void {
    const health = event.normalized as unknown as StreamHealth;
    if (health.name) {
      this.streamHealth.set(health.name, health);
    }
  }

  private applyRiskState(event: EventEnvelope): void {
    if (event.normalized.kill_switch_enabled !== undefined) {
      this.killSwitchEnabled = Boolean(event.normalized.kill_switch_enabled);
    }
  }

  private applyOrderSubmitted(event: EventEnvelope): void {
    const action = event.normalized.action as Record<string, unknown> | undefined;
    if (!action) {
      return;
    }
    const legs = action.legs as Array<Record<string, unknown>>;
    const leg = legs[0];
    const clientOrderId = String(action.client_order_id);
    this.orders.set(clientOrderId, {
      client_order_id: clientOrderId,
      action_id: String(action.action_id),
      status: "submitted",
      symbol: String(leg.symbol),
      underlying_symbol: String(action.underlying_symbol),
      side: leg.side as "buy" | "sell",
      qty: Number(action.qty),
      filled_qty: 0,
      limit_price: numberOrUndefined(action.limit_price),
      position_intent: leg.position_intent as OrderRecord["position_intent"],
      submitted_at_utc: event.received_at_utc,
      updated_at_utc: event.received_at_utc,
      replace_count: 0,
      raw: event.raw,
    });
  }

  private applyTradeUpdate(event: EventEnvelope): void {
    const normalized = event.normalized;
    const clientOrderId = String(normalized.client_order_id ?? "");
    if (!clientOrderId) {
      return;
    }
    const existing = this.orders.get(clientOrderId);
    const symbol = String(normalized.symbol ?? existing?.symbol ?? event.symbol ?? "");
    const side = String(normalized.side ?? existing?.side ?? "buy") as "buy" | "sell";
    const positionIntent = String(normalized.position_intent ?? existing?.position_intent ?? "buy_to_open") as OrderRecord["position_intent"];
    const status = normalizeOrderStatus(String(normalized.status ?? event.event_type));
    const filledQty = numberOrUndefined(normalized.filled_qty ?? normalized.qty) ?? existing?.filled_qty ?? 0;
    const fillPrice = numberOrUndefined(normalized.fill_price ?? normalized.price);
    const order: OrderRecord = {
      client_order_id: clientOrderId,
      action_id: existing?.action_id ?? String(normalized.action_id ?? clientOrderId),
      broker_order_id: String(normalized.broker_order_id ?? existing?.broker_order_id ?? ""),
      status,
      symbol,
      underlying_symbol: String(normalized.underlying_symbol ?? existing?.underlying_symbol ?? this.contracts.get(symbol)?.underlying_symbol ?? ""),
      side,
      qty: numberOrUndefined(normalized.qty) ?? existing?.qty ?? filledQty,
      filled_qty: filledQty,
      avg_fill_price: fillPrice ?? existing?.avg_fill_price,
      limit_price: numberOrUndefined(normalized.limit_price) ?? existing?.limit_price,
      position_intent: positionIntent,
      submitted_at_utc: existing?.submitted_at_utc,
      updated_at_utc: event.received_at_utc,
      replace_count: existing?.replace_count ?? 0,
      raw: event.raw,
    };
    this.orders.set(clientOrderId, order);
    if (status === "rejected") {
      this.recentRejects += 1;
    }
    if ((status === "filled" || event.event_type === "fill") && fillPrice !== undefined && filledQty > 0) {
      this.applyFill(order, filledQty, fillPrice, event.received_at_utc);
    }
  }

  private applyFill(order: OrderRecord, qty: number, fillPrice: number, at: string): void {
    if (order.position_intent === "buy_to_open") {
      const existing = this.positions.get(order.symbol);
      const newQty = (existing?.qty ?? 0) + qty;
      const avg =
        existing && existing.qty > 0
          ? (existing.avg_entry_price * existing.qty + fillPrice * qty) / newQty
          : fillPrice;
      const strategyType: StrategyType = this.contracts.get(order.symbol)?.right === "put" ? "long_put" : "long_call";
      const flattenAt = zonedTimeToUtc(new Date(at), this.config.session.force_flatten_time_et, this.config.system.timezone).toISOString();
      this.positions.set(order.symbol, {
        symbol: order.symbol,
        underlying_symbol: order.underlying_symbol,
        strategy_type: strategyType,
        qty: newQty,
        avg_entry_price: avg,
        opened_at_utc: existing?.opened_at_utc ?? at,
        last_mark_price: fillPrice,
        unrealized_pnl: 0,
        realized_pnl: existing?.realized_pnl ?? 0,
        stop_loss_price: avg * (1 - this.config.exit.stop_loss_pct),
        take_profit_price: avg * (1 + this.config.exit.take_profit_pct),
        force_flatten_at_utc: flattenAt,
        status: "open",
      });
      this.tradesToday += existing ? 0 : 1;
      return;
    }
    if (order.position_intent === "sell_to_close") {
      const existing = this.positions.get(order.symbol);
      if (!existing) {
        return;
      }
      const closedQty = Math.min(existing.qty, qty);
      const realized = (fillPrice - existing.avg_entry_price) * closedQty * 100;
      this.dailyRealizedPnl += realized;
      const remainingQty = existing.qty - closedQty;
      if (remainingQty <= 0) {
        this.positions.set(order.symbol, {
          ...existing,
          qty: 0,
          last_mark_price: fillPrice,
          realized_pnl: (existing.realized_pnl ?? 0) + realized,
          unrealized_pnl: 0,
          status: "closed",
        });
      } else {
        this.positions.set(order.symbol, {
          ...existing,
          qty: remainingQty,
          last_mark_price: fillPrice,
          realized_pnl: (existing.realized_pnl ?? 0) + realized,
          status: "open",
        });
      }
    }
  }

  markPositionsToMarket(): void {
    for (const position of this.positions.values()) {
      if (position.status === "closed") {
        continue;
      }
      const mark = optionMid(this.optionQuotes.get(position.symbol));
      if (mark === undefined) {
        continue;
      }
      position.last_mark_price = mark;
      position.unrealized_pnl = (mark - position.avg_entry_price) * position.qty * 100;
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeOrderStatus(status: string): OrderRecord["status"] {
  switch (status) {
    case "new":
    case "accepted":
      return "new";
    case "partially_filled":
      return "partially_filled";
    case "filled":
    case "fill":
      return "filled";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "rejected":
      return "rejected";
    case "replaced":
      return "replaced";
    default:
      return "submitted";
  }
}
