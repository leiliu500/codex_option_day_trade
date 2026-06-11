#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertSafeTradingMode, loadConfig, secretsFromEnv } from "./config/config";
import { EventFactory } from "./domain/events";
import { JsonlEventStore } from "./data/eventStore";
import { AlpacaRestClient } from "./broker/alpacaRest";
import { runReplayFromJsonl } from "./replay/replayRunner";
import { nowUtcIso } from "./util/time";

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
  const factory = new EventFactory(runId);
  const now = nowUtcIso();
  store.append(
    factory.next(
      "session_started",
      "execution",
      {
        run_id: runId,
        mode,
        config_hash: configHash,
        dry_run: Boolean(args.flags["dry-run"]),
      },
      { received_at_utc: now },
    ),
  );
  if (args.flags["dry-run"]) {
    console.log(JSON.stringify({ status: "ok", mode, run_id: runId, config_hash: configHash, event_log: `data/events/${runId}.jsonl` }, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        status: "initialized",
        mode,
        run_id: runId,
        config_hash: configHash,
        event_log: `data/events/${runId}.jsonl`,
        note: "Live stream supervisors are adapter-isolated; use check-alpaca before enabling a connected paper session.",
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
  check-alpaca --config configs/paper.yaml --paper
  replay-fixture tests/replay_fixtures/02_bullish_signal_risk_approved_order_submitted.jsonl --config configs/paper.yaml
`);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", message: (error as Error).message }, null, 2));
  process.exitCode = 1;
});
