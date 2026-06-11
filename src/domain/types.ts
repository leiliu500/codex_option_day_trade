export type TradingMode = "paper" | "live";
export type OptionRight = "call" | "put";
export type TradeActionType = "open" | "close" | "cancel" | "replace" | "no_trade";
export type StrategyType = "long_call" | "long_put" | "call_debit_spread" | "put_debit_spread";
export type RiskDecisionStatus = "approved" | "blocked";
export type SignalDirection = "bullish" | "bearish" | "neutral" | "none";
export type EventSource =
  | "alpaca_stock_stream"
  | "alpaca_option_stream"
  | "alpaca_trading_stream"
  | "alpaca_rest"
  | "strategy"
  | "risk"
  | "execution"
  | "position_manager"
  | "replay"
  | "fixture";

export interface OptionContract {
  symbol: string;
  underlying_symbol: string;
  expiration_date: string;
  strike_price: number;
  right: OptionRight;
  style?: string;
  status?: string;
  open_interest?: number;
  open_interest_date?: string;
  close_price?: number;
  close_price_date?: string;
  raw?: Record<string, unknown>;
}

export interface UnderlyingState {
  symbol: string;
  last_price?: number;
  bid?: number;
  ask?: number;
  vwap?: number;
  opening_range_high?: number;
  opening_range_low?: number;
  session_high?: number;
  session_low?: number;
  last_event_at_utc?: string;
  last_received_at_utc?: string;
}

export interface OptionQuoteState {
  symbol: string;
  bid?: number;
  ask?: number;
  bid_size?: number;
  ask_size?: number;
  last_trade_price?: number;
  last_trade_size?: number;
  quote_event_at_utc?: string;
  trade_event_at_utc?: string;
  received_at_utc?: string;
  implied_volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  snapshot_at_utc?: string;
}

export function optionMid(quote: OptionQuoteState | undefined): number | undefined {
  if (!quote || quote.bid === undefined || quote.ask === undefined) {
    return undefined;
  }
  if (quote.bid <= 0 || quote.ask <= 0 || quote.ask <= quote.bid) {
    return undefined;
  }
  return (quote.bid + quote.ask) / 2;
}

export interface Signal {
  signal_id: string;
  run_id: string;
  strategy_name: string;
  underlying_symbol: string;
  direction: SignalDirection;
  confidence: number;
  reason_codes: string[];
  features: Record<string, unknown>;
  created_at_utc: string;
}

export interface ContractCandidate {
  contract: OptionContract;
  quote: OptionQuoteState;
  abs_delta?: number;
  spread?: number;
  spread_pct_of_mid?: number;
  quote_age_seconds: number;
  score: number;
  reason_codes: string[];
}

export interface OrderLegIntent {
  symbol: string;
  side: "buy" | "sell";
  ratio_qty: number;
  position_intent: "buy_to_open" | "sell_to_open" | "buy_to_close" | "sell_to_close";
}

export interface TradeAction {
  action_id: string;
  client_order_id: string;
  action_type: TradeActionType;
  strategy_type?: StrategyType;
  underlying_symbol: string;
  legs: OrderLegIntent[];
  qty: number;
  order_type: "limit";
  limit_price?: number;
  time_in_force: "day";
  max_loss_dollars: number;
  entry_reason: string[];
  exit_reason: string[];
  created_at_utc: string;
}

export interface RiskDecision {
  risk_decision_id: string;
  action_id: string;
  status: RiskDecisionStatus;
  approved: boolean;
  blocked_reasons: string[];
  evaluated_rules: Record<string, unknown>;
  created_at_utc: string;
}

export interface EventEnvelope {
  event_id: string;
  run_id: string;
  event_type: string;
  source: EventSource;
  event_at_utc?: string;
  received_at_utc: string;
  sequence_num: number;
  symbol?: string;
  correlation_id?: string;
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  schema_version: number;
}

export interface StreamHealth {
  name: string;
  connected: boolean;
  authenticated: boolean;
  last_message_at_utc?: string;
  last_error?: string;
  reconnect_count: number;
  subscriptions: string[];
}

export interface PositionState {
  symbol: string;
  underlying_symbol: string;
  strategy_type: StrategyType;
  qty: number;
  avg_entry_price: number;
  opened_at_utc: string;
  last_mark_price?: number;
  highest_mark_price?: number;
  unrealized_pnl?: number;
  realized_pnl?: number;
  stop_loss_price?: number;
  take_profit_price?: number;
  force_flatten_at_utc: string;
  status: "open" | "closing" | "closed";
}

export interface OrderRecord {
  client_order_id: string;
  action_id: string;
  broker_order_id?: string;
  status:
    | "planned"
    | "risk_approved"
    | "risk_blocked"
    | "submitted"
    | "new"
    | "partially_filled"
    | "filled"
    | "cancel_requested"
    | "replace_requested"
    | "replaced"
    | "rejected"
    | "canceled";
  symbol: string;
  underlying_symbol: string;
  side: "buy" | "sell";
  qty: number;
  filled_qty: number;
  avg_fill_price?: number;
  limit_price?: number;
  position_intent: OrderLegIntent["position_intent"];
  submitted_at_utc?: string;
  updated_at_utc: string;
  replace_count: number;
  raw?: Record<string, unknown>;
}
