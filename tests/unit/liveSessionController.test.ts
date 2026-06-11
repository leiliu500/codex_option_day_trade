import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import type { EventFactory } from "../../src/domain/events";
import { EventFactory as EventFactoryImpl } from "../../src/domain/events";
import { LiveState } from "../../src/domain/state";
import type { EventEnvelope, OptionContract, TradeAction, UnderlyingState } from "../../src/domain/types";
import { InMemoryEventStore } from "../../src/data/eventStore";
import type { MarketDataAdapter, TradingAdapter } from "../../src/broker/protocols";
import { DomainEngine } from "../../src/engine/domainEngine";
import { LiveSessionController, type OptionSymbolStream } from "../../src/engine/liveSessionController";

test("live session before-market phase checks account, builds candidates, snapshots, and subscribes selected option symbols", async () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  const store = new InMemoryEventStore();
  const eventFactory = new EventFactoryImpl("live-test");
  const marketData = mockMarketData();
  const trading = mockTrading();
  const optionStream = new MockOptionStream();
  const engine = new DomainEngine({
    runId: "live-test",
    configHash,
    config,
    state,
    eventStore: store,
    eventFactory,
    executionAdapter: trading,
  });
  const controller = new LiveSessionController(config, state, store, eventFactory, marketData, trading, engine, {
    option: optionStream,
  });

  const result = await controller.initializeBeforeMarket("2026-06-11T13:20:00.000Z");

  assert.deepEqual(result.candidateSymbols, ["SPY260611C00100000", "SPY260611P00100000"]);
  assert.deepEqual(optionStream.symbols, ["SPY260611C00100000", "SPY260611P00100000"]);
  assert.equal(optionStream.connected, true);
  assert.equal(store.countByType("account_checked"), 1);
  assert.equal(store.countByType("watchlist_loaded"), 1);
  assert.equal(store.countByType("option_contract"), 2);
  assert.equal(store.countByType("option_snapshot"), 2);
  assert.equal(store.countByType("candidate_set_selected"), 1);
});

test("live session before-close phase disables new entries, cancels orders, evaluates exits, and writes final log", async () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  const store = new InMemoryEventStore();
  const eventFactory = new EventFactoryImpl("live-test");
  const trading = mockTrading();
  const engine = new DomainEngine({
    runId: "live-test",
    configHash,
    config,
    state,
    eventStore: store,
    eventFactory,
    executionAdapter: trading,
  });
  const controller = new LiveSessionController(config, state, store, eventFactory, mockMarketData(), trading, engine);

  await controller.shutdownBeforeClose("2026-06-11T19:30:00.000Z");

  assert.equal(state.newEntriesDisabled, true);
  assert.equal(store.countByType("orders_cancel_requested"), 1);
  assert.equal(store.countByType("final_trade_log"), 1);
});

test("live session schedules before-close closeout from configured force-flatten time", () => {
  const { config, configHash } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  const store = new InMemoryEventStore();
  const eventFactory = new EventFactoryImpl("live-test");
  const trading = mockTrading();
  const engine = new DomainEngine({
    runId: "live-test",
    configHash,
    config,
    state,
    eventStore: store,
    eventFactory,
    executionAdapter: trading,
  });
  const controller = new LiveSessionController(config, state, store, eventFactory, mockMarketData(), trading, engine);

  const timer = controller.scheduleBeforeClose("2026-06-11T19:30:00.000Z");
  clearTimeout(timer);

  assert.ok(timer);
});

function mockMarketData(): MarketDataAdapter {
  return {
    async getLatestUnderlyingQuote(underlying: string): Promise<UnderlyingState> {
      return {
        symbol: underlying,
        last_price: 100,
        bid: 99.99,
        ask: 100.01,
      };
    },
    async getOptionContracts(params): Promise<OptionContract[]> {
      const contracts: OptionContract[] = [
        {
          symbol: "SPY260611C00100000",
          underlying_symbol: "SPY",
          expiration_date: "2026-06-11",
          strike_price: 100,
          right: "call",
          status: "active",
          open_interest: 500,
        },
        {
          symbol: "SPY260611P00100000",
          underlying_symbol: "SPY",
          expiration_date: "2026-06-11",
          strike_price: 100,
          right: "put",
          status: "active",
          open_interest: 500,
        },
      ];
      return contracts.filter((contract) => contract.right === params.right);
    },
    async getOptionSnapshots(_underlying: string, symbols: string[]): Promise<Record<string, unknown>> {
      return Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          {
            implied_volatility: 0.24,
            greeks: { delta: symbol.includes("C") ? 0.52 : -0.52, gamma: 0.08, theta: -0.22 },
          },
        ]),
      );
    },
  };
}

function mockTrading(): TradingAdapter {
  return {
    async getAccount(): Promise<Record<string, unknown>> {
      return {
        status: "ACTIVE",
        options_trading_level: 2,
        buying_power: "10000",
      };
    },
    async submitOrder(): Promise<EventEnvelope[]> {
      return [];
    },
    async cancelAllOrders(eventFactory: EventFactory, nowIso: string): Promise<EventEnvelope[]> {
      return [eventFactory.next("orders_cancel_requested", "alpaca_rest", { requested_at_utc: nowIso }, { received_at_utc: nowIso })];
    },
  };
}

class MockOptionStream implements OptionSymbolStream {
  symbols: string[] = [];
  connected = false;

  setSymbols(symbols: string[]): void {
    this.symbols = symbols;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  close(): void {
    this.connected = false;
  }
}
