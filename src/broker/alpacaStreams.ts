import { decode } from "@msgpack/msgpack";
import type { AppConfig, RuntimeSecrets } from "../config/config";
import type { EventFactory } from "../domain/events";
import type { EventEnvelope } from "../domain/types";

export type StreamEventSink = (event: EventEnvelope) => void | Promise<void>;

export abstract class AlpacaWebSocketStream {
  private socket?: WebSocket;

  protected constructor(
    protected readonly config: AppConfig,
    protected readonly secrets: RuntimeSecrets,
    protected readonly eventFactory: EventFactory,
    protected readonly sink: StreamEventSink,
    protected readonly name: "stock" | "option" | "trading",
  ) {}

  async connect(): Promise<void> {
    if (!this.secrets.alpacaApiKey || !this.secrets.alpacaSecretKey) {
      throw new Error("Missing Alpaca credentials in environment.");
    }
    const socket = new WebSocket(this.url());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.emitHealth(true, true);
      this.authenticate();
      this.subscribe();
    });
    socket.addEventListener("message", (message) => {
      void this.handleMessage(message).catch((error) => {
        this.emitHealth(false, false, (error as Error).message);
      });
    });
    socket.addEventListener("error", () => this.emitHealth(false, false, "websocket_error"));
    socket.addEventListener("close", () => this.emitHealth(false, false, "websocket_closed"));
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  protected send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`${this.name} stream is not open.`);
    }
    this.socket.send(JSON.stringify(payload));
  }

  protected isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  protected authenticate(): void {
    if (this.name === "trading") {
      this.send({ action: "authenticate", data: { key_id: this.secrets.alpacaApiKey, secret_key: this.secrets.alpacaSecretKey } });
      return;
    }
    this.send({ action: "auth", key: this.secrets.alpacaApiKey, secret: this.secrets.alpacaSecretKey });
  }

  protected abstract url(): string;
  protected abstract subscribe(): void;
  protected abstract normalize(message: Record<string, unknown>): EventEnvelope | undefined;

  private async handleMessage(message: MessageEvent): Promise<void> {
    const decoded = await decodePayload(message.data);
    const messages = Array.isArray(decoded) ? decoded : [decoded];
    for (const item of messages) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const event = this.normalize(item as Record<string, unknown>);
      if (event) {
        await this.sink(event);
      }
    }
  }

  private emitHealth(connected: boolean, authenticated: boolean, lastError?: string): void {
    const now = new Date().toISOString();
    void this.sink(
      this.eventFactory.next(
        "stream_health",
        this.name === "trading" ? "alpaca_trading_stream" : this.name === "option" ? "alpaca_option_stream" : "alpaca_stock_stream",
        {
          name: this.name,
          connected,
          authenticated,
          last_message_at_utc: connected ? now : undefined,
          last_error: lastError,
          reconnect_count: 0,
          subscriptions: this.subscriptions(),
        },
        { received_at_utc: now },
      ),
    );
  }

  protected subscriptions(): string[] {
    return [];
  }
}

export class AlpacaStockStreamAdapter extends AlpacaWebSocketStream {
  constructor(
    config: AppConfig,
    secrets: RuntimeSecrets,
    eventFactory: EventFactory,
    sink: StreamEventSink,
    private readonly symbols: string[],
  ) {
    super(config, secrets, eventFactory, sink, "stock");
  }

  protected url(): string {
    return `wss://stream.data.alpaca.markets/v2/${this.config.alpaca.stock_feed}`;
  }

  protected subscribe(): void {
    this.send({ action: "subscribe", quotes: this.symbols, trades: this.symbols, bars: this.symbols });
  }

  protected subscriptions(): string[] {
    return this.symbols;
  }

  protected normalize(message: Record<string, unknown>): EventEnvelope | undefined {
    const type = String(message.T ?? message.t ?? message.stream ?? "");
    const symbol = String(message.S ?? message.symbol ?? "").toUpperCase();
    const now = new Date().toISOString();
    if (type === "q") {
      return this.eventFactory.next(
        "underlying_quote",
        "alpaca_stock_stream",
        {
          symbol,
          bid: message.bp,
          ask: message.ap,
          bid_size: message.bs,
          ask_size: message.as,
        },
        { raw: message, symbol, event_at_utc: String(message.t ?? now), received_at_utc: now },
      );
    }
    if (type === "t" || type === "b") {
      return this.eventFactory.next(
        "underlying_bar",
        "alpaca_stock_stream",
        {
          symbol,
          last_price: message.p ?? message.c,
          vwap: message.vw,
          volume: message.v,
        },
        { raw: message, symbol, event_at_utc: String(message.t ?? now), received_at_utc: now },
      );
    }
    return undefined;
  }
}

export class AlpacaOptionStreamAdapter extends AlpacaWebSocketStream {
  constructor(
    config: AppConfig,
    secrets: RuntimeSecrets,
    eventFactory: EventFactory,
    sink: StreamEventSink,
    private symbols: string[],
  ) {
    super(config, secrets, eventFactory, sink, "option");
    this.symbols = normalizeOptionSymbols(symbols, config.universe.max_contracts_per_underlying);
  }

  setSymbols(symbols: string[]): void {
    this.symbols = normalizeOptionSymbols(symbols, this.config.universe.max_contracts_per_underlying);
    if (this.symbols.length > 0 && this.isOpen()) {
      this.subscribe();
    }
  }

  protected url(): string {
    return `wss://stream.data.alpaca.markets/v1beta1/${this.config.alpaca.option_feed}`;
  }

  protected subscribe(): void {
    if (this.symbols.length === 0) {
      return;
    }
    this.send({ action: "subscribe", quotes: this.symbols, trades: this.symbols });
  }

  protected subscriptions(): string[] {
    return this.symbols;
  }

  protected normalize(message: Record<string, unknown>): EventEnvelope | undefined {
    const type = String(message.T ?? message.t ?? "");
    const symbol = String(message.S ?? message.symbol ?? "").toUpperCase();
    const now = new Date().toISOString();
    if (type === "q") {
      return this.eventFactory.next(
        "option_quote",
        "alpaca_option_stream",
        {
          symbol,
          bid: message.bp,
          ask: message.ap,
          bid_size: message.bs,
          ask_size: message.as,
        },
        { raw: message, symbol, event_at_utc: String(message.t ?? now), received_at_utc: now },
      );
    }
    if (type === "t") {
      return this.eventFactory.next(
        "option_trade",
        "alpaca_option_stream",
        {
          symbol,
          last_trade_price: message.p,
          last_trade_size: message.s,
        },
        { raw: message, symbol, event_at_utc: String(message.t ?? now), received_at_utc: now },
      );
    }
    return undefined;
  }
}

export function normalizeOptionSymbols(symbols: string[], maxSymbols: number): string[] {
  const selectedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  if (selectedSymbols.some((symbol) => symbol === "*" || symbol.includes("*"))) {
    throw new Error("Wildcard option stream subscriptions are not allowed.");
  }
  if (selectedSymbols.length > maxSymbols) {
    throw new Error(`Refusing to subscribe to ${selectedSymbols.length} option symbols; max is ${maxSymbols}.`);
  }
  return selectedSymbols;
}

export class AlpacaTradingStreamAdapter extends AlpacaWebSocketStream {
  constructor(config: AppConfig, secrets: RuntimeSecrets, eventFactory: EventFactory, sink: StreamEventSink) {
    super(config, secrets, eventFactory, sink, "trading");
  }

  protected url(): string {
    const base = this.secrets.alpacaBaseUrl.replace(/^http/, "ws");
    return `${base}/stream`;
  }

  protected subscribe(): void {
    this.send({ action: "listen", data: { streams: ["trade_updates"] } });
  }

  protected subscriptions(): string[] {
    return ["trade_updates"];
  }

  protected normalize(message: Record<string, unknown>): EventEnvelope | undefined {
    const stream = String(message.stream ?? "");
    const data = (message.data ?? message) as Record<string, unknown>;
    if (stream && stream !== "trade_updates") {
      return undefined;
    }
    const order = (data.order ?? {}) as Record<string, unknown>;
    const symbol = String(order.symbol ?? data.symbol ?? "");
    const now = new Date().toISOString();
    return this.eventFactory.next(
      "trade_update",
      "alpaca_trading_stream",
      {
        client_order_id: order.client_order_id ?? data.client_order_id,
        broker_order_id: order.id ?? data.id,
        status: data.event ?? order.status,
        symbol,
        side: order.side ?? data.side,
        qty: order.qty ?? data.qty,
        filled_qty: order.filled_qty ?? data.qty,
        fill_price: order.filled_avg_price ?? data.price,
        limit_price: order.limit_price,
        position_intent: order.position_intent,
      },
      { raw: message, symbol, event_at_utc: String(data.timestamp ?? now), received_at_utc: now },
    );
  }
}

async function decodePayload(data: unknown): Promise<unknown> {
  if (typeof data === "string") {
    return JSON.parse(data);
  }
  if (data instanceof ArrayBuffer) {
    return decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return decode(data as Uint8Array);
  }
  if (data instanceof Blob) {
    return decode(new Uint8Array(await data.arrayBuffer()));
  }
  return data;
}
