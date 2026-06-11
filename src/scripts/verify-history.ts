#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, secretsFromEnv, type AppConfig, type RuntimeSecrets } from "../config/config";
import { EventFactory } from "../domain/events";
import type { LiveState } from "../domain/state";
import type { EventEnvelope, OptionRight } from "../domain/types";
import type { ReplayReport } from "../replay/reports";
import { analyzeMissedOpportunities, type OpportunityVerificationSummary } from "../replay/missedOpportunityAnalyzer";
import { runEventsThroughProductionEngine } from "../replay/replayRunner";
import { zonedTimeToUtc } from "../util/time";
import { SimulatedExecutionAdapter } from "../broker/simulatedExecutionAdapter";

interface ParsedArgs {
  date: string;
  underlying: string;
  configPath: string;
  json: boolean;
}

export interface Bar {
  c: number;
  h: number;
  l: number;
  n?: number;
  o: number;
  t: string;
  v?: number;
  vw?: number;
}

export interface Trade {
  c?: string;
  p: number;
  s: number;
  t: string;
  x?: string;
}

export interface OptionCandidate {
  symbol: string;
  strike: number;
  right: OptionRight;
}

interface GreeksSnapshot {
  implied_volatility?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  solver_status: "ok" | "intrinsic_only" | "invalid_input";
}

export interface EntryFire {
  timestamp_utc: string;
  underlying: string;
  direction: string;
  risk_status: "approved" | "blocked";
  selected_contract: string;
  action_id?: string;
  client_order_id?: string;
  limit_price?: number;
  qty?: number;
  max_loss_dollars?: number;
  reason_codes: string[];
  blocked_reasons: string[];
}

export interface TradePnlRow {
  trade_id: string;
  symbol: string;
  underlying: string;
  strategy_type?: string;
  status: "submitted" | "entry_filled" | "closed";
  entry_submitted_at_utc: string;
  entry_filled_at_utc?: string;
  entry_price?: number;
  exit_submitted_at_utc?: string;
  exit_filled_at_utc?: string;
  exit_price?: number;
  qty: number;
  realized_pnl_dollars: number;
  unrealized_pnl_dollars?: number;
}

export interface HistoricalVerificationSummary {
  status: "ok";
  date: string;
  underlying: string;
  stock_bars: number;
  candidate_symbols: string[];
  option_bar_symbols: string[];
  option_trade_symbols: string[];
  quote_source: string;
  greeks_source: string;
  input_events: number;
  event_log: string;
  report_path: string;
  replay: ReplayReport;
  entries_fired: EntryFire[];
  trade_pnl: TradePnlRow[];
  opportunity_verification: OpportunityVerificationSummary;
  top_blocked_reasons: Record<string, number>;
}

interface HistoricalInputSet {
  inputEvents: EventEnvelope[];
  stockBars: Bar[];
  candidates: OptionCandidate[];
  optionBars: Record<string, Bar[]>;
  optionTrades: Record<string, Trade[]>;
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const summary = await runHistoricalVerification({
    date: args.date,
    underlying: args.underlying,
    configPath: args.configPath,
  });
  console.log(JSON.stringify(summary, null, args.json ? 2 : 0));
}

export async function runHistoricalVerification(params: {
  date: string;
  underlying: string;
  configPath: string;
}): Promise<HistoricalVerificationSummary> {
  const { config, configHash } = loadConfig(params.configPath);
  config.system.environment = "paper";
  config.alpaca.paper = true;
  config.replay.fill_model = "optimistic_mid";
  const secrets = secretsFromEnv();
  const { inputEvents, stockBars, candidates, optionBars, optionTrades } = await buildHistoricalInputEventsForDate({
    config,
    date: params.date,
    underlying: params.underlying,
    secrets,
  });
  const replay = await runEventsThroughProductionEngine({
    inputEvents,
    config,
    configHash,
    executionAdapter: new SimulatedExecutionAdapter(config),
    runIdPrefix: "replay-history",
  });
  const { outputEvents, report, state } = replay;
  const entriesFired = buildEntryFires(outputEvents);
  const tradePnl = buildTradePnl(outputEvents, state);
  const opportunityVerification = analyzeMissedOpportunities({ inputEvents, outputEvents });
  const safeName = `${params.underlying.toUpperCase()}-${params.date}`;
  const eventPath = join("data", "events", `historical-${safeName}.jsonl`);
  const reportPath = join(config.replay.report_dir, `historical-${safeName}.json`);
  mkdirSync(join("data", "events"), { recursive: true });
  mkdirSync(config.replay.report_dir, { recursive: true });
  writeFileSync(eventPath, `${inputEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const summary: HistoricalVerificationSummary = {
    status: "ok",
    date: params.date,
    underlying: params.underlying.toUpperCase(),
    stock_bars: stockBars.length,
    candidate_symbols: candidates.map((candidate) => candidate.symbol),
    option_bar_symbols: Object.keys(optionBars).filter((symbol) => (optionBars[symbol]?.length ?? 0) > 0),
    option_trade_symbols: Object.keys(optionTrades).filter((symbol) => (optionTrades[symbol]?.length ?? 0) > 0),
    quote_source: "historical_option_bars_bid_ask_model_from_opra_trades",
    greeks_source: "black_scholes_iv_solver_from_historical_underlying_and_option_mid",
    input_events: inputEvents.length,
    event_log: eventPath,
    report_path: reportPath,
    replay: report,
    entries_fired: entriesFired,
    trade_pnl: tradePnl,
    opportunity_verification: opportunityVerification,
    top_blocked_reasons: countBlockedReasons(outputEvents),
  };
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

export async function buildHistoricalInputEventsForDate(params: {
  config: AppConfig;
  date: string;
  underlying: string;
  secrets: RuntimeSecrets;
}): Promise<HistoricalInputSet> {
  const range = sessionRangeUtc(params.date, params.config);
  const stockBars = await fetchStockBars(params.underlying, range.startIso, range.endIso, params.config, params.secrets);
  if (stockBars.length === 0) {
    throw new Error(`No ${params.underlying} stock bars returned for ${params.date}.`);
  }

  const candidates = buildCandidates(params.underlying, params.date, stockBars, params.config);
  const optionBars = await fetchOptionBars(candidates.map((candidate) => candidate.symbol), range.startIso, range.endIso, params.secrets);
  const optionTrades = await fetchOptionTrades(candidates.map((candidate) => candidate.symbol), range.startIso, range.endIso, params.secrets);
  const availableCandidates = candidates.filter((candidate) => (optionBars[candidate.symbol]?.length ?? 0) > 0);
  if (availableCandidates.length === 0) {
    throw new Error(`No option bars returned for ${params.underlying} ${params.date} candidates.`);
  }
  const inputEvents = buildHistoricalEvents({
    config: params.config,
    date: params.date,
    underlying: params.underlying,
    stockBars,
    candidates: availableCandidates,
    optionBars,
    optionTrades,
  });
  return { inputEvents, stockBars, candidates: availableCandidates, optionBars, optionTrades };
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith("--")) {
      flags.add(value.slice(2));
      if (value === "--config") {
        i += 1;
      }
    } else {
      positional.push(value);
    }
  }
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : "configs/paper.yaml";
  const date = positional[0] ?? "2026-06-10";
  const underlying = (positional[1] ?? "SPY").toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Date must be YYYY-MM-DD.");
  }
  return { date, underlying, configPath, json: flags.has("json") };
}

export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals < 1) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    process.env[key] ??= value;
  }
}

function sessionRangeUtc(date: string, config: AppConfig): { startIso: string; endIso: string } {
  const anchor = new Date(`${date}T16:00:00.000Z`);
  return {
    startIso: zonedTimeToUtc(anchor, config.session.regular_open_et, config.system.timezone).toISOString(),
    endIso: zonedTimeToUtc(anchor, config.session.regular_close_et, config.system.timezone).toISOString(),
  };
}

async function fetchStockBars(
  underlying: string,
  startIso: string,
  endIso: string,
  config: AppConfig,
  secrets: RuntimeSecrets,
): Promise<Bar[]> {
  const bars: Bar[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${secrets.alpacaDataUrl}/v2/stocks/${underlying}/bars`);
    url.searchParams.set("start", startIso);
    url.searchParams.set("end", endIso);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("feed", config.alpaca.stock_feed);
    url.searchParams.set("limit", "10000");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const payload = await requestJson(url, secrets);
    bars.push(...normalizeBars(payload.bars));
    pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : undefined;
  } while (pageToken);
  return bars.sort((a, b) => a.t.localeCompare(b.t));
}

async function fetchOptionBars(
  symbols: string[],
  startIso: string,
  endIso: string,
  secrets: RuntimeSecrets,
): Promise<Record<string, Bar[]>> {
  const output: Record<string, Bar[]> = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  let pageToken: string | undefined;
  do {
    const url = new URL(`${secrets.alpacaDataUrl}/v1beta1/options/bars`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("start", startIso);
    url.searchParams.set("end", endIso);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("limit", "10000");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const payload = await requestJson(url, secrets);
    const barsBySymbol = (payload.bars ?? {}) as Record<string, unknown>;
    for (const [symbol, rawBars] of Object.entries(barsBySymbol)) {
      output[symbol] = [...(output[symbol] ?? []), ...normalizeBars(rawBars)];
    }
    pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : undefined;
  } while (pageToken);
  for (const symbol of Object.keys(output)) {
    output[symbol].sort((a, b) => a.t.localeCompare(b.t));
  }
  return output;
}

async function fetchOptionTrades(
  symbols: string[],
  startIso: string,
  endIso: string,
  secrets: RuntimeSecrets,
): Promise<Record<string, Trade[]>> {
  const output: Record<string, Trade[]> = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  let pageToken: string | undefined;
  do {
    const url = new URL(`${secrets.alpacaDataUrl}/v1beta1/options/trades`);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("start", startIso);
    url.searchParams.set("end", endIso);
    url.searchParams.set("limit", "10000");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const payload = await requestJson(url, secrets);
    const tradesBySymbol = (payload.trades ?? {}) as Record<string, unknown>;
    for (const [symbol, rawTrades] of Object.entries(tradesBySymbol)) {
      output[symbol] = [...(output[symbol] ?? []), ...normalizeTrades(rawTrades)];
    }
    pageToken = typeof payload.next_page_token === "string" ? payload.next_page_token : undefined;
  } while (pageToken);
  for (const symbol of Object.keys(output)) {
    output[symbol].sort((a, b) => a.t.localeCompare(b.t));
  }
  return output;
}

function buildCandidates(underlying: string, date: string, stockBars: Bar[], config: AppConfig): OptionCandidate[] {
  const bySymbol = new Map<string, OptionCandidate>();
  const refreshMs = Math.max(1, config.universe.refresh_interval_seconds) * 1000;
  let nextRefreshAt = Number.NEGATIVE_INFINITY;
  for (const bar of stockBars) {
    const at = Date.parse(bar.t);
    if (at < nextRefreshAt) {
      continue;
    }
    nextRefreshAt = at + refreshMs;
    const nearestFive = Math.round(bar.c / 5) * 5;
    const strikes = [-10, -5, 0, 5, 10].map((offset) => nearestFive + offset);
    for (const strike of strikes) {
      for (const right of ["call", "put"] as const) {
        const candidate = { symbol: optionSymbol(underlying, date, right, strike), strike, right };
        bySymbol.set(candidate.symbol, candidate);
      }
    }
    if (bySymbol.size >= config.universe.max_contracts_per_underlying) {
      break;
    }
  }
  return [...bySymbol.values()].slice(0, config.universe.max_contracts_per_underlying);
}

function optionSymbol(underlying: string, date: string, right: OptionRight, strike: number): string {
  const [year, month, day] = date.split("-");
  const yy = year.slice(2);
  const code = right === "call" ? "C" : "P";
  const strikeCode = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${underlying.toUpperCase()}${yy}${month}${day}${code}${strikeCode}`;
}

function buildHistoricalEvents(params: {
  config: AppConfig;
  date: string;
  underlying: string;
  stockBars: Bar[];
  candidates: OptionCandidate[];
  optionBars: Record<string, Bar[]>;
  optionTrades: Record<string, Trade[]>;
}): EventEnvelope[] {
  const sourceRunId = `historical-${params.underlying.toUpperCase()}-${params.date}`;
  const factory = new EventFactory(sourceRunId);
  const events: EventEnvelope[] = [];
  const openingRange = computeOpeningRange(params.stockBars, params.config.strategy.opening_range_minutes);
  const barsByTime = new Map(params.stockBars.map((bar) => [bar.t, bar]));
  const stockBarsSorted = [...params.stockBars].sort((a, b) => a.t.localeCompare(b.t));
  const optionBarsBySymbolAndTime = new Map(
    params.candidates.map((candidate) => [
      candidate.symbol,
      new Map((params.optionBars[candidate.symbol] ?? []).map((bar) => [bar.t, bar])),
    ]),
  );

  const firstAt = params.stockBars[0].t;
  for (const candidate of params.candidates) {
    events.push(
      factory.next(
        "option_contract",
        "alpaca_rest",
        {
          symbol: candidate.symbol,
          underlying_symbol: params.underlying.toUpperCase(),
          expiration_date: params.date,
          strike_price: candidate.strike,
          right: candidate.right,
          status: "active",
          open_interest: 1000,
        },
        { symbol: candidate.symbol, received_at_utc: firstAt },
      ),
    );
    events.push(
      factory.next(
        "option_snapshot",
        "alpaca_rest",
        {
          symbol: candidate.symbol,
          ...deriveGreeks({
            optionMidPrice: params.optionBars[candidate.symbol]?.[0]?.c,
            underlyingPrice: params.stockBars[0].c,
            strike: candidate.strike,
            right: candidate.right,
            atIso: firstAt,
            expirationDate: params.date,
            timezone: params.config.system.timezone,
          }),
        },
        { symbol: candidate.symbol, received_at_utc: firstAt },
      ),
    );
  }

  let cumulativeVwapDollars = 0;
  let cumulativeVolume = 0;
  for (const at of [...barsByTime.keys()].sort()) {
    const bar = barsByTime.get(at)!;
    const volume = bar.v ?? 0;
    if (bar.vw !== undefined && volume > 0) {
      cumulativeVwapDollars += bar.vw * volume;
      cumulativeVolume += volume;
    }
    const sessionVwap = cumulativeVolume > 0 ? cumulativeVwapDollars / cumulativeVolume : bar.vw;
    for (const healthName of ["stock", "option", "trading"]) {
      events.push(
        factory.next(
          "stream_health",
          healthName === "stock" ? "alpaca_stock_stream" : healthName === "option" ? "alpaca_option_stream" : "alpaca_trading_stream",
          {
            name: healthName,
            connected: true,
            authenticated: true,
            last_message_at_utc: at,
            reconnect_count: 0,
            subscriptions: healthName === "stock" ? [params.underlying] : healthName === "option" ? params.candidates.map((item) => item.symbol) : ["trade_updates"],
          },
          { received_at_utc: at },
        ),
      );
    }
    for (const candidate of params.candidates) {
      const optionBar = optionBarsBySymbolAndTime.get(candidate.symbol)?.get(at);
      if (!optionBar) {
        continue;
      }
      const mid = optionBar.c;
      const spread = modeledSpread(optionBar);
      const greeks = deriveGreeks({
        optionMidPrice: mid,
        underlyingPrice: bar.c,
        strike: candidate.strike,
        right: candidate.right,
        atIso: at,
        expirationDate: params.date,
        timezone: params.config.system.timezone,
      });
      events.push(
        factory.next(
          "option_snapshot",
          "alpaca_rest",
          {
            symbol: candidate.symbol,
            ...greeks,
          },
          { raw: { model: "black_scholes", source_bar: optionBar } as Record<string, unknown>, symbol: candidate.symbol, received_at_utc: at },
        ),
      );
      events.push(
        factory.next(
          "option_quote",
          "alpaca_option_stream",
          {
            symbol: candidate.symbol,
            bid: round(Math.max(0.01, mid - spread / 2), 4),
            ask: round(mid + spread / 2, 4),
            bid_size: 10,
            ask_size: 10,
          },
          { raw: optionBar as unknown as Record<string, unknown>, symbol: candidate.symbol, event_at_utc: at, received_at_utc: at },
        ),
      );
    }
    events.push(
      factory.next(
        "underlying_bar",
        "alpaca_stock_stream",
        {
          symbol: params.underlying.toUpperCase(),
          last_price: bar.c,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          vwap: sessionVwap,
          volume,
          opening_range_high: openingRange.high,
          opening_range_low: openingRange.low,
        },
        { raw: bar as unknown as Record<string, unknown>, symbol: params.underlying.toUpperCase(), event_at_utc: at, received_at_utc: at },
      ),
    );
  }
  for (const candidate of params.candidates) {
    const trades = downsampleTrades(params.optionTrades[candidate.symbol] ?? [], 15);
    for (const trade of trades) {
      events.push(
        factory.next(
          "option_trade",
          "alpaca_option_stream",
          {
            symbol: candidate.symbol,
            last_trade_price: trade.p,
            last_trade_size: trade.s,
          },
          { raw: trade as unknown as Record<string, unknown>, symbol: candidate.symbol, event_at_utc: trade.t, received_at_utc: trade.t },
        ),
      );
      const underlyingBar = latestBarAtOrBefore(stockBarsSorted, trade.t);
      if (underlyingBar) {
        events.push(
          factory.next(
            "underlying_bar",
            "alpaca_stock_stream",
            {
              symbol: params.underlying.toUpperCase(),
              last_price: underlyingBar.c,
              close: underlyingBar.c,
              vwap: underlyingBar.vw,
              volume: underlyingBar.v,
              opening_range_high: openingRange.high,
              opening_range_low: openingRange.low,
            },
            {
              raw: { model: "latest_stock_bar_at_option_trade", source_bar: underlyingBar } as Record<string, unknown>,
              symbol: params.underlying.toUpperCase(),
              event_at_utc: trade.t,
              received_at_utc: trade.t,
            },
          ),
        );
      }
    }
  }
  return events.sort((a, b) => a.received_at_utc.localeCompare(b.received_at_utc) || a.sequence_num - b.sequence_num);
}

function computeOpeningRange(bars: Bar[], minutes: number): { high: number; low: number } {
  const startMs = Date.parse(bars[0].t);
  const endMs = startMs + minutes * 60 * 1000;
  const openingBars = bars.filter((bar) => Date.parse(bar.t) < endMs);
  return {
    high: Math.max(...openingBars.map((bar) => bar.h)),
    low: Math.min(...openingBars.map((bar) => bar.l)),
  };
}

function modeledSpread(bar: Bar): number {
  const observedRange = Math.max(0, bar.h - bar.l);
  return Math.max(0.01, Math.min(Math.max(observedRange, bar.c * 0.03), Math.max(0.01, bar.c * 0.12)));
}

function deriveGreeks(params: {
  optionMidPrice: number | undefined;
  underlyingPrice: number;
  strike: number;
  right: OptionRight;
  atIso: string;
  expirationDate: string;
  timezone: string;
}): GreeksSnapshot {
  if (
    params.optionMidPrice === undefined ||
    params.optionMidPrice <= 0 ||
    params.underlyingPrice <= 0 ||
    params.strike <= 0
  ) {
    return { solver_status: "invalid_input" };
  }
  const yearsToExpiration = Math.max(
    1 / (365 * 24 * 60),
    (expirationUtc(params.expirationDate, params.timezone).getTime() - Date.parse(params.atIso)) / (365 * 24 * 60 * 60 * 1000),
  );
  const intrinsic =
    params.right === "call"
      ? Math.max(0, params.underlyingPrice - params.strike)
      : Math.max(0, params.strike - params.underlyingPrice);
  const adjustedPrice = Math.max(params.optionMidPrice, intrinsic + 0.005);
  const iv = impliedVolatility({
    optionPrice: adjustedPrice,
    underlyingPrice: params.underlyingPrice,
    strike: params.strike,
    yearsToExpiration,
    right: params.right,
    riskFreeRate: 0.04,
  });
  if (iv === undefined) {
    const fallback = 0.3;
    return { ...blackScholesGreeks(params.underlyingPrice, params.strike, yearsToExpiration, fallback, params.right, 0.04), solver_status: "intrinsic_only" };
  }
  return { ...blackScholesGreeks(params.underlyingPrice, params.strike, yearsToExpiration, iv, params.right, 0.04), solver_status: "ok" };
}

function expirationUtc(date: string, timezone: string): Date {
  return zonedTimeToUtc(new Date(`${date}T16:00:00.000Z`), "16:00:00", timezone);
}

function impliedVolatility(params: {
  optionPrice: number;
  underlyingPrice: number;
  strike: number;
  yearsToExpiration: number;
  right: OptionRight;
  riskFreeRate: number;
}): number | undefined {
  let low = 0.01;
  let high = 5;
  const lowPrice = blackScholesPrice(params.underlyingPrice, params.strike, params.yearsToExpiration, low, params.right, params.riskFreeRate);
  const highPrice = blackScholesPrice(params.underlyingPrice, params.strike, params.yearsToExpiration, high, params.right, params.riskFreeRate);
  if (params.optionPrice < lowPrice - 0.05 || params.optionPrice > highPrice + 0.05) {
    return undefined;
  }
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice(params.underlyingPrice, params.strike, params.yearsToExpiration, mid, params.right, params.riskFreeRate);
    if (price > params.optionPrice) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return round((low + high) / 2, 6);
}

function blackScholesPrice(
  underlyingPrice: number,
  strike: number,
  yearsToExpiration: number,
  volatility: number,
  right: OptionRight,
  riskFreeRate: number,
): number {
  const { d1, d2 } = d1d2(underlyingPrice, strike, yearsToExpiration, volatility, riskFreeRate);
  const discountedStrike = strike * Math.exp(-riskFreeRate * yearsToExpiration);
  if (right === "call") {
    return underlyingPrice * normCdf(d1) - discountedStrike * normCdf(d2);
  }
  return discountedStrike * normCdf(-d2) - underlyingPrice * normCdf(-d1);
}

function blackScholesGreeks(
  underlyingPrice: number,
  strike: number,
  yearsToExpiration: number,
  volatility: number,
  right: OptionRight,
  riskFreeRate: number,
): Omit<GreeksSnapshot, "solver_status"> {
  const { d1, d2 } = d1d2(underlyingPrice, strike, yearsToExpiration, volatility, riskFreeRate);
  const pdf = normPdf(d1);
  const sqrtT = Math.sqrt(yearsToExpiration);
  const discountedStrike = strike * Math.exp(-riskFreeRate * yearsToExpiration);
  const delta = right === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf / (underlyingPrice * volatility * sqrtT);
  const annualTheta =
    right === "call"
      ? -(underlyingPrice * pdf * volatility) / (2 * sqrtT) - riskFreeRate * discountedStrike * normCdf(d2)
      : -(underlyingPrice * pdf * volatility) / (2 * sqrtT) + riskFreeRate * discountedStrike * normCdf(-d2);
  const vega = (underlyingPrice * pdf * sqrtT) / 100;
  return {
    implied_volatility: round(volatility, 6),
    delta: round(delta, 6),
    gamma: round(gamma, 6),
    theta: round(annualTheta / 365, 6),
    vega: round(vega, 6),
  };
}

function d1d2(
  underlyingPrice: number,
  strike: number,
  yearsToExpiration: number,
  volatility: number,
  riskFreeRate: number,
): { d1: number; d2: number } {
  const sqrtT = Math.sqrt(yearsToExpiration);
  const d1 = (Math.log(underlyingPrice / strike) + (riskFreeRate + 0.5 * volatility * volatility) * yearsToExpiration) / (volatility * sqrtT);
  return { d1, d2: d1 - volatility * sqrtT };
}

function normPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function normCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

function downsampleTrades(trades: Trade[], maxFrequencySeconds: number): Trade[] {
  const selected: Trade[] = [];
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const trade of trades) {
    const at = Date.parse(trade.t);
    if (at - lastAt < maxFrequencySeconds * 1000) {
      continue;
    }
    selected.push(trade);
    lastAt = at;
  }
  return selected;
}

function latestBarAtOrBefore(bars: Bar[], atIso: string): Bar | undefined {
  const at = Date.parse(atIso);
  let latest: Bar | undefined;
  for (const bar of bars) {
    if (Date.parse(bar.t) > at) {
      break;
    }
    latest = bar;
  }
  return latest;
}

export function buildEntryFires(events: EventEnvelope[]): EntryFire[] {
  const entries: EntryFire[] = [];
  for (const event of events) {
    if (event.event_type !== "decision_approved" && event.event_type !== "decision_blocked") {
      continue;
    }
    const action = event.normalized.action as Record<string, unknown> | undefined;
    const signal = event.normalized.signal as Record<string, unknown> | undefined;
    const legs = Array.isArray(action?.legs) ? (action.legs as Array<Record<string, unknown>>) : [];
    const direction = String(signal?.direction ?? "");
    if (direction !== "bullish" && direction !== "bearish") {
      continue;
    }
    const riskDecision = event.normalized.risk_decision as Record<string, unknown> | undefined;
    const blockedReasons = Array.isArray(riskDecision?.blocked_reasons) ? riskDecision.blocked_reasons.map(String) : [];
    const limitPrice = numberOrUndefined(action?.limit_price);
    entries.push({
      timestamp_utc: event.received_at_utc,
      underlying: String(action?.underlying_symbol ?? signal?.underlying_symbol ?? event.symbol ?? ""),
      direction,
      risk_status: event.event_type === "decision_approved" ? "approved" : "blocked",
      selected_contract: String(event.normalized.selected_contract ?? legs[0].symbol ?? ""),
      ...(action?.action_id === undefined ? {} : { action_id: String(action.action_id) }),
      ...(action?.client_order_id === undefined ? {} : { client_order_id: String(action.client_order_id) }),
      ...(limitPrice === undefined ? {} : { limit_price: limitPrice }),
      ...(action?.qty === undefined ? {} : { qty: Number(action.qty) }),
      ...(action?.max_loss_dollars === undefined ? {} : { max_loss_dollars: Number(action.max_loss_dollars) }),
      reason_codes: Array.isArray(signal?.reason_codes) ? signal.reason_codes.map(String) : [],
      blocked_reasons: blockedReasons,
    });
  }
  return entries;
}

export function buildTradePnl(events: EventEnvelope[], state: LiveState): TradePnlRow[] {
  const rows: TradePnlRow[] = [];
  const openBySymbol = new Map<string, TradePnlRow[]>();
  const rowByEntryClientOrderId = new Map<string, TradePnlRow>();
  const closeOrders = new Map<string, { symbol: string; submittedAt: string; qty: number }>();

  for (const event of events) {
    if (event.event_type === "order_submitted") {
      const action = event.normalized.action as Record<string, unknown> | undefined;
      const legs = Array.isArray(action?.legs) ? (action.legs as Array<Record<string, unknown>>) : [];
      const leg = legs[0];
      if (!action || !leg) {
        continue;
      }
      const symbol = String(leg.symbol ?? "");
      const clientOrderId = String(action.client_order_id ?? "");
      if (action.action_type === "open") {
        const row: TradePnlRow = {
          trade_id: String(action.action_id ?? clientOrderId),
          symbol,
          underlying: String(action.underlying_symbol ?? ""),
          strategy_type: typeof action.strategy_type === "string" ? action.strategy_type : undefined,
          status: "submitted",
          entry_submitted_at_utc: event.received_at_utc,
          qty: Number(action.qty ?? 0),
          realized_pnl_dollars: 0,
        };
        rows.push(row);
        rowByEntryClientOrderId.set(clientOrderId, row);
        const list = openBySymbol.get(symbol) ?? [];
        list.push(row);
        openBySymbol.set(symbol, list);
        continue;
      }
      if (action.action_type === "close") {
        closeOrders.set(clientOrderId, {
          symbol,
          submittedAt: event.received_at_utc,
          qty: Number(action.qty ?? 0),
        });
      }
      continue;
    }

    if (event.event_type !== "trade_update") {
      continue;
    }
    const normalized = event.normalized;
    const clientOrderId = String(normalized.client_order_id ?? "");
    const status = String(normalized.status ?? "");
    if (status !== "filled") {
      continue;
    }
    const positionIntent = String(normalized.position_intent ?? "");
    const fillPrice = numberOrUndefined(normalized.fill_price ?? normalized.price);
    const filledQty = Number(normalized.filled_qty ?? normalized.qty ?? 0);
    if (positionIntent === "buy_to_open") {
      const row = rowByEntryClientOrderId.get(clientOrderId);
      if (!row) {
        continue;
      }
      row.status = "entry_filled";
      row.entry_filled_at_utc = event.received_at_utc;
      row.entry_price = fillPrice;
      row.qty = filledQty || row.qty;
      const mark = state.optionQuotes.get(row.symbol);
      if (fillPrice !== undefined && mark?.bid !== undefined && mark.ask !== undefined && mark.ask > mark.bid) {
        row.unrealized_pnl_dollars = round((((mark.bid + mark.ask) / 2) - fillPrice) * row.qty * 100, 2);
      }
      continue;
    }
    if (positionIntent === "sell_to_close") {
      const closeOrder = closeOrders.get(clientOrderId);
      if (!closeOrder) {
        continue;
      }
      let remainingQty = filledQty || closeOrder.qty;
      for (const row of openBySymbol.get(closeOrder.symbol) ?? []) {
        if (remainingQty <= 0) {
          break;
        }
        if (row.status !== "entry_filled") {
          continue;
        }
        const closingQty = Math.min(row.qty, remainingQty);
        row.status = "closed";
        row.exit_submitted_at_utc = closeOrder.submittedAt;
        row.exit_filled_at_utc = event.received_at_utc;
        row.exit_price = fillPrice;
        if (row.entry_price !== undefined && fillPrice !== undefined) {
          row.realized_pnl_dollars = round((fillPrice - row.entry_price) * closingQty * 100, 2);
          row.unrealized_pnl_dollars = 0;
        }
        remainingQty -= closingQty;
      }
    }
  }

  return rows;
}

function countBlockedReasons(events: EventEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.event_type !== "risk_decision") {
      continue;
    }
    const riskDecision = event.normalized.risk_decision as { blocked_reasons?: string[] };
    for (const reason of riskDecision.blocked_reasons ?? []) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10));
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function requestJson(url: URL, secrets: RuntimeSecrets): Promise<Record<string, unknown>> {
  if (!secrets.alpacaApiKey || !secrets.alpacaSecretKey) {
    throw new Error("Missing Alpaca credentials in environment or .env.");
  }
  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": secrets.alpacaApiKey,
      "APCA-API-SECRET-KEY": secrets.alpacaSecretKey,
    },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new Error(`Alpaca HTTP ${response.status}: ${redact(JSON.stringify(payload))}`);
  }
  return payload;
}

function normalizeBars(raw: unknown): Bar[] {
  return Array.isArray(raw)
    ? raw
        .map((item) => item as Partial<Bar>)
        .filter((item): item is Bar => typeof item.t === "string" && Number.isFinite(item.c) && Number.isFinite(item.h) && Number.isFinite(item.l) && Number.isFinite(item.o))
    : [];
}

function normalizeTrades(raw: unknown): Trade[] {
  return Array.isArray(raw)
    ? raw
        .map((item) => item as Partial<Trade>)
        .filter((item): item is Trade => typeof item.t === "string" && Number.isFinite(item.p) && Number.isFinite(item.s))
    : [];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function redact(text: string): string {
  return text
    .replace(/APCA-API-KEY-ID[^,}]+/gi, "APCA-API-KEY-ID:redacted")
    .replace(/APCA-API-SECRET-KEY[^,}]+/gi, "APCA-API-SECRET-KEY:redacted");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", message: (error as Error).message }, null, 2));
    process.exitCode = 1;
  });
}
