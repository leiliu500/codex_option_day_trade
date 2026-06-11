#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertSafeTradingMode, loadConfig, secretsFromEnv } from "./config/config";
import { EventFactory } from "./domain/events";
import { JsonlEventStore } from "./data/eventStore";
import { AlpacaRestClient } from "./broker/alpacaRest";
import { AlpacaOptionStreamAdapter, AlpacaStockStreamAdapter, AlpacaTradingStreamAdapter } from "./broker/alpacaStreams";
import { runReplayFromJsonl } from "./replay/replayRunner";
import { formatZonedIso, nowUtcIso } from "./util/time";
import { LiveState } from "./domain/state";
import { DomainEngine } from "./engine/domainEngine";
import { LiveSessionController } from "./engine/liveSessionController";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "run":
      await runCommand(args);
      break;
    case "check-alpaca":
      await checkAlpaca(args);
      break;
    case "replay":
    case "replay-fixture":
      await replayCommand(args);
      break;
    case "help":
    case "":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

async function runCommand(args: ParsedArgs): Promise<void> {
  const { config, configHash } = loadConfig(stringFlag(args, "config") ?? "configs/paper.yaml");
  const mode = assertSafeTradingMode(config, { paper: Boolean(args.flags.paper), live: Boolean(args.flags.live) });
  const runId = randomUUID();
  mkdirSync("data/events", { recursive: true });
  const store = new JsonlEventStore(join("data/events", `${runId}.jsonl`));
  const factory = new EventFactory(runId, config.system.timezone);
  const now = nowUtcIso();
  const nowEt = formatZonedIso(now, config.system.timezone);
  store.append(
    factory.next(
      "session_started",
      "execution",
      {
        run_id: runId,
        mode,
        config_hash: configHash,
        timezone: config.system.timezone,
        started_at_utc: now,
        started_at_et: nowEt,
        dry_run: Boolean(args.flags["dry-run"]),
      },
      { received_at_utc: now },
    ),
  );
  if (args.flags["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          mode,
          run_id: runId,
          config_hash: configHash,
          timezone: config.system.timezone,
          started_at_utc: now,
          started_at_et: nowEt,
          event_log: `data/events/${runId}.jsonl`,
        },
        null,
        2,
      ),
    );
    return;
  }
  const secrets = secretsFromEnv();
  const client = new AlpacaRestClient(config, secrets);
  const state = new LiveState(config);
  const engine = new DomainEngine({
    runId,
    configHash,
    config,
    state,
    eventStore: store,
    eventFactory: factory,
    executionAdapter: client,
  });
  let controller: LiveSessionController;
  const sink = async (event: Parameters<LiveSessionController["handleMarketEvent"]>[0]) => {
    await controller.handleMarketEvent(event);
  };
  const streams = {
    stock: new AlpacaStockStreamAdapter(config, secrets, factory, sink, config.watchlist.underlyings),
    option: new AlpacaOptionStreamAdapter(config, secrets, factory, sink, []),
    trading: new AlpacaTradingStreamAdapter(config, secrets, factory, sink),
  };
  controller = new LiveSessionController(config, state, store, factory, client, client, engine, streams);
  const initialized = await controller.initializeBeforeMarket(now);
  const closeoutTimer = controller.scheduleBeforeClose(now);
  process.once("SIGINT", () => {
    clearTimeout(closeoutTimer);
    void controller.shutdownBeforeClose().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    clearTimeout(closeoutTimer);
    void controller.shutdownBeforeClose().finally(() => process.exit(0));
  });
  console.log(
    JSON.stringify(
      {
        status: "running",
        mode,
        run_id: runId,
        config_hash: configHash,
        timezone: config.system.timezone,
        started_at_utc: now,
        started_at_et: nowEt,
        event_log: `data/events/${runId}.jsonl`,
        candidate_symbols: initialized.candidateSymbols.length,
        note: "Before-market checks completed, selected option contracts are subscribed, and stream events now drive the shared domain engine.",
      },
      null,
      2,
    ),
  );
}

async function checkAlpaca(args: ParsedArgs): Promise<void> {
  const { config } = loadConfig(stringFlag(args, "config") ?? "configs/paper.yaml");
  assertSafeTradingMode(config, { paper: true, live: false });
  const client = new AlpacaRestClient(config, secretsFromEnv());
  const account = await client.getAccount();
  console.log(
    JSON.stringify(
      {
        status: "ok",
        account_number: account.account_number,
        status_text: account.status,
        options_trading_level: account.options_trading_level,
        paper: config.alpaca.paper,
      },
      null,
      2,
    ),
  );
}

async function replayCommand(args: ParsedArgs): Promise<void> {
  const eventPath = args.positional[0] ?? stringFlag(args, "events");
  if (!eventPath) {
    throw new Error("replay requires a JSONL event file path.");
  }
  const report = await runReplayFromJsonl({
    eventPath,
    configPath: stringFlag(args, "config") ?? "configs/paper.yaml",
    writeReport: Boolean(args.flags["write-report"]),
  });
  console.log(JSON.stringify(report, null, 2));
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i];
    if (value.startsWith("--")) {
      const name = value.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(value);
    }
  }
  return { command, positional, flags };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function printHelp(): void {
  console.log(`lotd commands:
  run --config configs/paper.yaml --paper --dry-run
  run --config configs/paper.yaml --paper
  check-alpaca --config configs/paper.yaml --paper
  replay-fixture tests/replay_fixtures/02_bullish_signal_risk_approved_order_submitted.jsonl --config configs/paper.yaml
`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", message: (error as Error).message }, null, 2));
  process.exitCode = 1;
});
