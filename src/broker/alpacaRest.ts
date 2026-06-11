import type { AppConfig, RuntimeSecrets } from "../config/config";
import type { MarketDataAdapter, TradingAdapter } from "./protocols";
import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventEnvelope, OptionContract, TradeAction } from "../domain/types";

export class AlpacaRestClient implements MarketDataAdapter, TradingAdapter {
  constructor(
    private readonly config: AppConfig,
    private readonly secrets: RuntimeSecrets,
  ) {}

  async getAccount(): Promise<Record<string, unknown>> {
    return this.requestJson(`${this.secrets.alpacaBaseUrl}/v2/account`);
  }

  async getOptionContracts(params: {
    underlying: string;
    expirationDateGte?: string;
    expirationDateLte?: string;
    strikePriceGte?: number;
    strikePriceLte?: number;
    right?: "call" | "put";
  }): Promise<OptionContract[]> {
    const output: OptionContract[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.secrets.alpacaBaseUrl}/v2/options/contracts`);
      url.searchParams.set("underlying_symbols", params.underlying);
      url.searchParams.set("status", "active");
      url.searchParams.set("limit", "10000");
      if (params.right) url.searchParams.set("type", params.right);
      if (params.expirationDateGte) url.searchParams.set("expiration_date_gte", params.expirationDateGte);
      if (params.expirationDateLte) url.searchParams.set("expiration_date_lte", params.expirationDateLte);
      if (params.strikePriceGte !== undefined) url.searchParams.set("strike_price_gte", String(params.strikePriceGte));
      if (params.strikePriceLte !== undefined) url.searchParams.set("strike_price_lte", String(params.strikePriceLte));
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const payload = await this.requestJson(url.toString());
      const contracts = Array.isArray(payload.option_contracts) ? payload.option_contracts : [];
      for (const raw of contracts as Record<string, unknown>[]) {
        output.push(normalizeContract(raw));
      }
      pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : undefined;
    } while (pageToken);
    return output.slice(0, this.config.universe.max_contracts_per_underlying);
  }

  async getOptionSnapshots(underlying: string, symbols?: string[]): Promise<Record<string, unknown>> {
    if (symbols?.length) {
      const url = new URL(`${this.secrets.alpacaDataUrl}/v1beta1/options/snapshots`);
      url.searchParams.set("symbols", symbols.join(","));
      return this.requestJson(url.toString());
    }
    const output: Record<string, unknown> = {};
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.secrets.alpacaDataUrl}/v1beta1/options/snapshots/${underlying}`);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const payload = await this.requestJson(url.toString());
      Object.assign(output, payload.snapshots ?? payload);
      pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : undefined;
    } while (pageToken);
    return output;
  }

  async submitOrder(
    action: TradeAction,
    _state: LiveState,
    nowIso: string,
    eventFactory: EventFactory,
  ): Promise<EventEnvelope[]> {
    const leg = action.legs[0];
    const payload: Record<string, unknown> =
      action.legs.length === 1
        ? {
            symbol: leg.symbol,
            qty: String(action.qty),
            side: leg.side,
            type: "limit",
            time_in_force: "day",
            limit_price: action.limit_price?.toFixed(2),
            extended_hours: false,
            position_intent: leg.position_intent,
            client_order_id: action.client_order_id,
          }
        : {
            order_class: "mleg",
            qty: String(action.qty),
            type: "limit",
            time_in_force: "day",
            limit_price: action.limit_price?.toFixed(2),
            client_order_id: action.client_order_id,
            legs: action.legs.map((item) => ({
              symbol: item.symbol,
              ratio_qty: String(item.ratio_qty),
              side: item.side,
              position_intent: item.position_intent,
            })),
          };
    const raw = await this.requestJson(`${this.secrets.alpacaBaseUrl}/v2/orders`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return [
      eventFactory.next(
        "trade_update",
        "alpaca_rest",
        {
          client_order_id: action.client_order_id,
          broker_order_id: raw.id,
          action_id: action.action_id,
          status: raw.status ?? "accepted",
          symbol: leg.symbol,
          underlying_symbol: action.underlying_symbol,
          side: leg.side,
          qty: action.qty,
          limit_price: action.limit_price,
          position_intent: leg.position_intent,
        },
        { raw: raw as Record<string, unknown>, symbol: leg.symbol, correlation_id: action.action_id, received_at_utc: nowIso },
      ),
    ];
  }

  private async requestJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    if (!this.secrets.alpacaApiKey || !this.secrets.alpacaSecretKey) {
      throw new Error("Missing Alpaca credentials in environment.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.alpaca.rest_timeout_seconds * 1000);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "APCA-API-KEY-ID": this.secrets.alpacaApiKey,
          "APCA-API-SECRET-KEY": this.secrets.alpacaSecretKey,
          ...(init.headers ?? {}),
        },
      });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!response.ok) {
        throw new Error(`Alpaca HTTP ${response.status}: ${redact(JSON.stringify(body))}`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeContract(raw: Record<string, unknown>): OptionContract {
  return {
    symbol: String(raw.symbol),
    underlying_symbol: String(raw.underlying_symbol ?? raw.underlying_symbols ?? "").toUpperCase(),
    expiration_date: String(raw.expiration_date),
    strike_price: Number(raw.strike_price),
    right: String(raw.type ?? raw.right).toLowerCase() === "put" ? "put" : "call",
    style: typeof raw.style === "string" ? raw.style : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    open_interest: raw.open_interest === undefined ? undefined : Number(raw.open_interest),
    open_interest_date: typeof raw.open_interest_date === "string" ? raw.open_interest_date : undefined,
    close_price: raw.close_price === undefined ? undefined : Number(raw.close_price),
    close_price_date: typeof raw.close_price_date === "string" ? raw.close_price_date : undefined,
    raw,
  };
}

function redact(text: string): string {
  return text
    .replace(/APCA-API-KEY-ID[^,}]+/gi, "APCA-API-KEY-ID:redacted")
    .replace(/APCA-API-SECRET-KEY[^,}]+/gi, "APCA-API-SECRET-KEY:redacted");
}
