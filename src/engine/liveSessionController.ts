import { isRiskLimitEnabled, type AppConfig } from "../config/config";
import type { MarketDataAdapter, TradingAdapter } from "../broker/protocols";
import type { EventStore } from "../data/eventStore";
import type { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventEnvelope } from "../domain/types";
import { DomainEngine } from "./domainEngine";
import { SnapshotRefresher } from "./snapshotRefresher";
import { UniverseBuilder } from "./universeBuilder";
import { nowUtcIso, zonedTimeToUtc } from "../util/time";

export interface ConnectableStream {
  connect(): Promise<void>;
  close(): void;
}

export interface OptionSymbolStream extends ConnectableStream {
  setSymbols(symbols: string[]): void;
}

export interface LiveStreamBundle {
  stock?: ConnectableStream;
  option?: OptionSymbolStream;
  trading?: ConnectableStream;
}

export interface LiveInitializationResult {
  account: Record<string, unknown>;
  candidateSymbols: string[];
}

export class LiveSessionController {
  private readonly universeBuilder: UniverseBuilder;
  private readonly snapshotRefresher: SnapshotRefresher;

  constructor(
    private readonly config: AppConfig,
    private readonly state: LiveState,
    private readonly eventStore: EventStore,
    private readonly eventFactory: EventFactory,
    private readonly marketData: MarketDataAdapter,
    private readonly trading: TradingAdapter,
    private readonly domainEngine: DomainEngine,
    private readonly streams: LiveStreamBundle = {},
  ) {
    this.universeBuilder = new UniverseBuilder(config, marketData, eventFactory, eventStore);
    this.snapshotRefresher = new SnapshotRefresher(config, marketData, eventFactory, eventStore);
  }

  async initializeBeforeMarket(nowIso = nowUtcIso()): Promise<LiveInitializationResult> {
    const account = await this.trading.getAccount();
    this.verifyAccount(account);
    this.appendEvent("account_checked", "alpaca_rest", {
      status: account.status,
      buying_power: account.buying_power,
      options_trading_level: account.options_trading_level ?? account.options_approved_level,
    }, nowIso);
    this.appendEvent("watchlist_loaded", "execution", { underlyings: this.config.watchlist.underlyings }, nowIso);

    const candidateSymbols: string[] = [];
    for (const underlying of this.config.watchlist.underlyings) {
      const quote = await this.marketData.getLatestUnderlyingQuote(underlying);
      const quoteEvent = this.eventFactory.next("underlying_quote", "alpaca_rest", quote as unknown as Record<string, unknown>, {
        symbol: underlying,
        event_at_utc: quote.last_event_at_utc,
        received_at_utc: nowIso,
        raw: quote as unknown as Record<string, unknown>,
      });
      this.eventStore.append(quoteEvent);
      this.state.applyEvent(quoteEvent);

      const contracts = await this.universeBuilder.refreshForUnderlying(this.state, underlying, nowIso);
      const symbols = contracts.map((contract) => contract.symbol);
      candidateSymbols.push(...symbols);
      await this.snapshotRefresher.refreshSymbols(this.state, underlying, symbols, nowIso);
    }

    const selectedSymbols = [...new Set(candidateSymbols)].slice(0, this.config.universe.max_contracts_per_underlying);
    this.streams.option?.setSymbols(selectedSymbols);
    this.appendEvent("candidate_set_selected", "execution", { symbols: selectedSymbols }, nowIso);
    await this.connectStreams();
    return { account, candidateSymbols: selectedSymbols };
  }

  async handleMarketEvent(event: EventEnvelope): Promise<void> {
    this.eventStore.append(event);
    await this.domainEngine.handleEvent(event);
  }

  scheduleBeforeClose(nowIso = nowUtcIso()): NodeJS.Timeout {
    const closeoutAtUtc = zonedTimeToUtc(
      new Date(nowIso),
      this.config.session.force_flatten_time_et,
      this.config.system.timezone,
    ).getTime();
    const delayMs = Math.max(0, closeoutAtUtc - Date.parse(nowIso));
    return setTimeout(() => {
      void this.shutdownBeforeClose(new Date().toISOString());
    }, delayMs);
  }

  async shutdownBeforeClose(nowIso = nowUtcIso()): Promise<void> {
    const entryBlock = this.eventFactory.next(
      "risk_state",
      "risk",
      { new_entries_disabled: true, reason: "before_close" },
      { received_at_utc: nowIso },
    );
    this.eventStore.append(entryBlock);
    this.state.applyEvent(entryBlock);

    if (this.trading.cancelAllOrders) {
      const cancelEvents = await this.trading.cancelAllOrders(this.eventFactory, nowIso);
      for (const event of cancelEvents) {
        this.eventStore.append(event);
        this.state.applyEvent(event);
      }
    }

    await this.domainEngine.evaluate(nowIso);
    this.appendEvent(
      "final_trade_log",
      "execution",
      {
        open_orders: this.state.getOpenOrders(),
        open_positions: this.state.getOpenPositions(),
        daily_realized_pnl: this.state.dailyRealizedPnl,
      },
      nowIso,
    );
    this.closeStreams();
  }

  private async connectStreams(): Promise<void> {
    await this.streams.stock?.connect();
    await this.streams.trading?.connect();
    await this.streams.option?.connect();
  }

  private closeStreams(): void {
    this.streams.option?.close();
    this.streams.trading?.close();
    this.streams.stock?.close();
  }

  private appendEvent(eventType: string, source: EventEnvelope["source"], normalized: Record<string, unknown>, nowIso: string): void {
    this.eventStore.append(this.eventFactory.next(eventType, source, normalized, { received_at_utc: nowIso }));
  }

  private verifyAccount(account: Record<string, unknown>): void {
    if (typeof account.status === "string" && !["ACTIVE", "active"].includes(account.status)) {
      throw new Error(`Alpaca account is not active: ${account.status}`);
    }
    const optionsLevel = Number(account.options_trading_level ?? account.options_approved_level ?? 0);
    if (!Number.isFinite(optionsLevel) || optionsLevel < 2) {
      throw new Error("Alpaca account is not approved for long option day trades.");
    }
    const buyingPower = Number(account.buying_power ?? account.regt_buying_power ?? 0);
    if (!Number.isFinite(buyingPower) || buyingPower <= 0) {
      throw new Error("Insufficient buying power for option day trades.");
    }
    if (
      isRiskLimitEnabled(this.config.risk.max_loss_per_trade_dollars) &&
      buyingPower < this.config.risk.max_loss_per_trade_dollars
    ) {
      throw new Error("Insufficient buying power for configured max loss per trade.");
    }
  }
}
