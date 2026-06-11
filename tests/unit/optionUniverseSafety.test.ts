import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config/config";
import { InMemoryEventStore } from "../../src/data/eventStore";
import { EventFactory } from "../../src/domain/events";
import { LiveState } from "../../src/domain/state";
import type { OptionContract } from "../../src/domain/types";
import type { MarketDataAdapter } from "../../src/broker/protocols";
import { normalizeOptionSymbols } from "../../src/broker/alpacaStreams";
import { SnapshotRefresher } from "../../src/engine/snapshotRefresher";

test("option stream subscriptions reject wildcard and oversized symbol sets", () => {
  assert.throws(() => normalizeOptionSymbols(["*"], 100), /Wildcard option stream subscriptions/);
  assert.throws(
    () => normalizeOptionSymbols(Array.from({ length: 101 }, (_, index) => `SPY260611C00${index}`), 100),
    /Refusing to subscribe/,
  );
  assert.deepEqual(normalizeOptionSymbols([" spy260611c00100000 ", "SPY260611C00100000"], 100), [
    "SPY260611C00100000",
  ]);
});

test("snapshot refresher loads snapshots only for selected candidate symbols", async () => {
  const { config } = loadConfig("configs/paper.yaml");
  const state = new LiveState(config);
  const symbolsSeen: string[][] = [];
  const marketData: MarketDataAdapter = {
    async getLatestUnderlyingQuote() {
      return { symbol: "SPY", last_price: 100, bid: 99.99, ask: 100.01 };
    },
    async getOptionContracts(): Promise<OptionContract[]> {
      return [];
    },
    async getOptionSnapshots(_underlying: string, symbols: string[]): Promise<Record<string, unknown>> {
      symbolsSeen.push(symbols);
      return Object.fromEntries(
        symbols.map((symbol) => [
          symbol,
          {
            latest_quote: { bid: 0.9, ask: 0.98 },
            latest_trade: { price: 0.95, size: 1 },
            greeks: { delta: 0.5 },
          },
        ]),
      );
    },
  };

  for (const symbol of ["SPY260611C00100000", "SPY260611P00100000"]) {
    state.contracts.set(symbol, {
      symbol,
      underlying_symbol: "SPY",
      expiration_date: "2026-06-11",
      strike_price: 100,
      right: symbol.includes("C") ? "call" : "put",
      status: "active",
      open_interest: 500,
    });
  }

  const store = new InMemoryEventStore();
  const refresher = new SnapshotRefresher(config, marketData, new EventFactory("test-run"), store);
  const count = await refresher.refreshUnderlying(state, "SPY", "2026-06-11T14:00:00.000Z");

  assert.equal(count, 2);
  assert.deepEqual(symbolsSeen, [["SPY260611C00100000", "SPY260611P00100000"]]);
  assert.equal(store.countByType("option_snapshot"), 2);
});
