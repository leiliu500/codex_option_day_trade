#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, secretsFromEnv, type AppConfig } from "../config/config";
import { loadJsonlEvents } from "../data/eventStore";
import type { EventEnvelope } from "../domain/types";
import { SimulatedExecutionAdapter } from "../broker/simulatedExecutionAdapter";
import { runEventsThroughProductionEngine } from "../replay/replayRunner";
import { sha256 } from "../util/hash";
import { clockPlusMinutes } from "../util/time";
import {
  buildEntryFires,
  buildHistoricalInputEventsForDate,
  buildTradePnl,
  loadDotEnv,
  type EntryFire,
  type TradePnlRow,
} from "./verify-history";

interface ParsedArgs {
  startDate: string;
  endDate: string;
  underlying: string;
  configPath: string;
  noCache: boolean;
  json: boolean;
}

interface StrategyProfile {
  name: string;
  session: Pick<AppConfig["session"], "entry_start_buffer_minutes">;
  strategy: Pick<
    AppConfig["strategy"],
    | "max_opening_range_bps"
    | "min_underlying_momentum_bps"
    | "min_breakout_bps"
    | "min_vwap_distance_bps"
    | "entry_cooldown_seconds"
    | "min_new_move_bps"
    | "entry_confirmation_seconds"
  >;
  exit: Pick<
    AppConfig["exit"],
    | "take_profit_pct"
    | "stop_loss_pct"
    | "breakeven_trigger_pct"
    | "trailing_stop_activation_pct"
    | "trailing_stop_pct"
    | "time_stop_minutes"
    | "defer_loss_exits_while_underlying_trend_valid"
  >;
}

interface DayResult {
  date: string;
  pnl: number;
  entries: number;
  approved_entries: number;
  closed_trades: number;
  submitted_only: number;
  wins: number;
  losses: number;
  max_trade_loss: number;
}

interface ProfileResult {
  profile: StrategyProfile;
  train: ScoreSummary;
  test: ScoreSummary;
  all: ScoreSummary;
  days: DayResult[];
}

interface ScoreSummary {
  dates: string[];
  pnl: number;
  entries: number;
  closed_trades: number;
  submitted_only: number;
  wins: number;
  losses: number;
  max_trade_loss: number;
  score: number;
}

interface OptimizationReport {
  status: "ok";
  underlying: string;
  start_date: string;
  end_date: string;
  train_dates: string[];
  test_dates: string[];
  profiles_tested: number;
  best_profile: StrategyProfile;
  results: ProfileResult[];
  report_path: string;
}

const PROFILES: StrategyProfile[] = [
  {
    name: "baseline_30min_no_range",
    session: {
      entry_start_buffer_minutes: 30,
    },
    strategy: {
      min_underlying_momentum_bps: 15,
      max_opening_range_bps: null,
      min_breakout_bps: 6,
      min_vwap_distance_bps: 5,
      entry_cooldown_seconds: 600,
      min_new_move_bps: 25,
      entry_confirmation_seconds: 0,
    },
    exit: {
      take_profit_pct: 0.6,
      stop_loss_pct: 0.12,
      breakeven_trigger_pct: 0.12,
      trailing_stop_activation_pct: 0.2,
      trailing_stop_pct: 0.1,
      time_stop_minutes: 10,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "entry_45min_no_range",
    session: {
      entry_start_buffer_minutes: 45,
    },
    strategy: {
      min_underlying_momentum_bps: 15,
      max_opening_range_bps: null,
      min_breakout_bps: 6,
      min_vwap_distance_bps: 5,
      entry_cooldown_seconds: 600,
      min_new_move_bps: 25,
      entry_confirmation_seconds: 0,
    },
    exit: {
      take_profit_pct: 0.6,
      stop_loss_pct: 0.12,
      breakeven_trigger_pct: 0.12,
      trailing_stop_activation_pct: 0.2,
      trailing_stop_pct: 0.1,
      time_stop_minutes: 10,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "current_30min_range_filter",
    session: {
      entry_start_buffer_minutes: 30,
    },
    strategy: {
      min_underlying_momentum_bps: 15,
      max_opening_range_bps: 25,
      min_breakout_bps: 6,
      min_vwap_distance_bps: 5,
      entry_cooldown_seconds: 600,
      min_new_move_bps: 25,
      entry_confirmation_seconds: 0,
    },
    exit: {
      take_profit_pct: 0.6,
      stop_loss_pct: 0.12,
      breakeven_trigger_pct: 0.12,
      trailing_stop_activation_pct: 0.2,
      trailing_stop_pct: 0.1,
      time_stop_minutes: 10,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "strict_quality",
    session: {
      entry_start_buffer_minutes: 45,
    },
    strategy: {
      min_underlying_momentum_bps: 20,
      max_opening_range_bps: 25,
      min_breakout_bps: 8,
      min_vwap_distance_bps: 8,
      entry_cooldown_seconds: 900,
      min_new_move_bps: 35,
      entry_confirmation_seconds: 180,
    },
    exit: {
      take_profit_pct: 0.5,
      stop_loss_pct: 0.1,
      breakeven_trigger_pct: 0.1,
      trailing_stop_activation_pct: 0.18,
      trailing_stop_pct: 0.08,
      time_stop_minutes: 8,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "deep_breakout",
    session: {
      entry_start_buffer_minutes: 45,
    },
    strategy: {
      min_underlying_momentum_bps: 20,
      max_opening_range_bps: 25,
      min_breakout_bps: 10,
      min_vwap_distance_bps: 6,
      entry_cooldown_seconds: 900,
      min_new_move_bps: 40,
      entry_confirmation_seconds: 300,
    },
    exit: {
      take_profit_pct: 0.7,
      stop_loss_pct: 0.12,
      breakeven_trigger_pct: 0.12,
      trailing_stop_activation_pct: 0.22,
      trailing_stop_pct: 0.1,
      time_stop_minutes: 12,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "responsive_capture",
    session: {
      entry_start_buffer_minutes: 45,
    },
    strategy: {
      min_underlying_momentum_bps: 12,
      max_opening_range_bps: 25,
      min_breakout_bps: 5,
      min_vwap_distance_bps: 4,
      entry_cooldown_seconds: 600,
      min_new_move_bps: 25,
      entry_confirmation_seconds: 60,
    },
    exit: {
      take_profit_pct: 0.4,
      stop_loss_pct: 0.1,
      breakeven_trigger_pct: 0.1,
      trailing_stop_activation_pct: 0.16,
      trailing_stop_pct: 0.08,
      time_stop_minutes: 8,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "runner_only",
    session: {
      entry_start_buffer_minutes: 45,
    },
    strategy: {
      min_underlying_momentum_bps: 15,
      max_opening_range_bps: 25,
      min_breakout_bps: 8,
      min_vwap_distance_bps: 5,
      entry_cooldown_seconds: 1200,
      min_new_move_bps: 40,
      entry_confirmation_seconds: 300,
    },
    exit: {
      take_profit_pct: 0.8,
      stop_loss_pct: 0.12,
      breakeven_trigger_pct: 0.14,
      trailing_stop_activation_pct: 0.25,
      trailing_stop_pct: 0.12,
      time_stop_minutes: 15,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
  {
    name: "tight_scalper",
    session: {
      entry_start_buffer_minutes: 45,
    },
    strategy: {
      min_underlying_momentum_bps: 20,
      max_opening_range_bps: 25,
      min_breakout_bps: 6,
      min_vwap_distance_bps: 5,
      entry_cooldown_seconds: 600,
      min_new_move_bps: 30,
      entry_confirmation_seconds: 120,
    },
    exit: {
      take_profit_pct: 0.35,
      stop_loss_pct: 0.08,
      breakeven_trigger_pct: 0.08,
      trailing_stop_activation_pct: 0.14,
      trailing_stop_pct: 0.06,
      time_stop_minutes: 5,
      defer_loss_exits_while_underlying_trend_valid: true,
    },
  },
];

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const { config: baseConfig } = loadConfig(args.configPath);
  baseConfig.system.environment = "paper";
  baseConfig.alpaca.paper = true;
  baseConfig.replay.fill_model = "optimistic_mid";
  const dates = businessDates(args.startDate, args.endDate);
  const trainCount = Math.max(1, Math.floor(dates.length * 0.7));
  const trainDates = dates.slice(0, trainCount);
  const testDates = dates.slice(trainCount);
  const inputEventsByDate = new Map<string, EventEnvelope[]>();
  for (const date of dates) {
    inputEventsByDate.set(date, await loadOrFetchEvents(date, args, baseConfig));
  }

  const results: ProfileResult[] = [];
  for (const profile of PROFILES) {
    const days: DayResult[] = [];
    for (const date of dates) {
      if (!args.json) {
        console.error(`[optimize] ${profile.name} ${date}`);
      }
      const config = profileConfig(baseConfig, profile);
      const result = await runEventsThroughProductionEngine({
        inputEvents: inputEventsByDate.get(date)!,
        config,
        configHash: sha256(config),
        executionAdapter: new SimulatedExecutionAdapter(config),
        runIdPrefix: `optimize-${profile.name}`,
      });
      days.push(dayResult(date, result.outputEvents, result.state));
    }
    results.push({
      profile,
      train: summarize(days.filter((day) => trainDates.includes(day.date))),
      test: summarize(days.filter((day) => testDates.includes(day.date))),
      all: summarize(days),
      days,
    });
  }

  results.sort((a, b) => b.test.score - a.test.score || b.train.score - a.train.score || b.all.score - a.all.score);
  const safeName = `${args.underlying}-${args.startDate}-${args.endDate}`;
  const reportPath = join(baseConfig.replay.report_dir, `optimize-${safeName}.json`);
  const report: OptimizationReport = {
    status: "ok",
    underlying: args.underlying,
    start_date: args.startDate,
    end_date: args.endDate,
    train_dates: trainDates,
    test_dates: testDates,
    profiles_tested: PROFILES.length,
    best_profile: results[0].profile,
    results,
    report_path: reportPath,
  };
  mkdirSync(baseConfig.replay.report_dir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(args.json ? report : compactReport(report), null, 2));
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const configIndex = argv.indexOf("--config");
  const startDate = positional[0] ?? "2026-06-05";
  const endDate = positional[1] ?? "2026-06-10";
  const underlying = (positional[2] ?? "SPY").toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error("Start and end dates must be YYYY-MM-DD.");
  }
  return {
    startDate,
    endDate,
    underlying,
    configPath: configIndex >= 0 ? argv[configIndex + 1] : "configs/paper.yaml",
    noCache: argv.includes("--no-cache"),
    json: argv.includes("--json"),
  };
}

async function loadOrFetchEvents(date: string, args: ParsedArgs, baseConfig: AppConfig): Promise<EventEnvelope[]> {
  const eventPath = join("data", "events", `historical-${args.underlying}-${date}.jsonl`);
  if (!args.noCache && existsSync(eventPath)) {
    return loadJsonlEvents(eventPath);
  }
  const input = await buildHistoricalInputEventsForDate({
    config: baseConfig,
    date,
    underlying: args.underlying,
    secrets: secretsFromEnv(),
  });
  mkdirSync(join("data", "events"), { recursive: true });
  writeFileSync(eventPath, `${input.inputEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  return input.inputEvents;
}

function profileConfig(baseConfig: AppConfig, profile: StrategyProfile): AppConfig {
  const config = structuredClone(baseConfig) as AppConfig;
  Object.assign(config.session, profile.session);
  config.session.entry_start_buffer_minutes = Math.max(30, Math.floor(config.session.entry_start_buffer_minutes));
  config.session.first_entry_time_et = clockPlusMinutes(config.session.regular_open_et, config.session.entry_start_buffer_minutes);
  Object.assign(config.strategy, profile.strategy);
  Object.assign(config.exit, profile.exit);
  config.system.environment = "paper";
  config.alpaca.paper = true;
  config.replay.fill_model = "optimistic_mid";
  return config;
}

function dayResult(date: string, outputEvents: EventEnvelope[], state: unknown): DayResult {
  const entries = buildEntryFires(outputEvents);
  const trades = buildTradePnl(outputEvents, state as Parameters<typeof buildTradePnl>[1]);
  const closed = trades.filter((trade) => trade.status === "closed");
  const pnl = closed.reduce((sum, trade) => sum + trade.realized_pnl_dollars, 0);
  return {
    date,
    pnl: round(pnl, 2),
    entries: entries.length,
    approved_entries: entries.filter((entry: EntryFire) => entry.risk_status === "approved").length,
    closed_trades: closed.length,
    submitted_only: trades.filter((trade) => trade.status === "submitted").length,
    wins: closed.filter((trade: TradePnlRow) => trade.realized_pnl_dollars > 0).length,
    losses: closed.filter((trade: TradePnlRow) => trade.realized_pnl_dollars < 0).length,
    max_trade_loss: Math.min(0, ...closed.map((trade) => trade.realized_pnl_dollars)),
  };
}

function summarize(days: DayResult[]): ScoreSummary {
  const pnl = round(days.reduce((sum, day) => sum + day.pnl, 0), 2);
  const entries = days.reduce((sum, day) => sum + day.entries, 0);
  const closedTrades = days.reduce((sum, day) => sum + day.closed_trades, 0);
  const submittedOnly = days.reduce((sum, day) => sum + day.submitted_only, 0);
  const wins = days.reduce((sum, day) => sum + day.wins, 0);
  const losses = days.reduce((sum, day) => sum + day.losses, 0);
  const maxTradeLoss = Math.min(0, ...days.map((day) => day.max_trade_loss));
  const inactivityPenalty = entries === 0 ? 1000 : 0;
  return {
    dates: days.map((day) => day.date),
    pnl,
    entries,
    closed_trades: closedTrades,
    submitted_only: submittedOnly,
    wins,
    losses,
    max_trade_loss: maxTradeLoss,
    score: round(pnl - entries * 2 - submittedOnly * 10 + maxTradeLoss * 0.5 - inactivityPenalty, 2),
  };
}

function compactReport(report: OptimizationReport): Record<string, unknown> {
  return {
    status: report.status,
    underlying: report.underlying,
    train_dates: report.train_dates,
    test_dates: report.test_dates,
    profiles_tested: report.profiles_tested,
    report_path: report.report_path,
    best_profile: report.best_profile,
    ranking: report.results.map((result) => ({
      profile: result.profile.name,
      train: result.train,
      test: result.test,
      all: result.all,
    })),
  };
}

function businessDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", message: (error as Error).message }, null, 2));
    process.exitCode = 1;
  });
}
