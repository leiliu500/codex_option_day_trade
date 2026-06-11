import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type AppConfig } from "../config/config";
import { EventFactory } from "../domain/events";
import { LiveState } from "../domain/state";
import { InMemoryEventStore, loadJsonlEvents } from "../data/eventStore";
import { DomainEngine } from "../engine/domainEngine";
import { SimulatedExecutionAdapter } from "../broker/simulatedExecutionAdapter";
import { buildReplayReport, type ReplayReport } from "./reports";
import type { EventEnvelope } from "../domain/types";
import type { ExecutionAdapter } from "../broker/protocols";

export interface ProductionReplayResult {
  replayId: string;
  runId: string;
  state: LiveState;
  inputEvents: EventEnvelope[];
  outputEvents: EventEnvelope[];
  report: ReplayReport;
}

export async function runEventsThroughProductionEngine(params: {
  inputEvents: EventEnvelope[];
  config: AppConfig;
  configHash: string;
  executionAdapter?: ExecutionAdapter;
  runIdPrefix?: string;
}): Promise<ProductionReplayResult> {
  const replayId = randomUUID();
  const runId = `${params.runIdPrefix ?? "replay"}-${replayId}`;
  const eventFactory = new EventFactory(runId);
  const store = new InMemoryEventStore();
  const state = new LiveState(params.config);
  const engine = new DomainEngine({
    runId,
    configHash: params.configHash,
    config: params.config,
    state,
    eventStore: store,
    eventFactory,
    executionAdapter: params.executionAdapter ?? new SimulatedExecutionAdapter(params.config),
  });
  for (const event of params.inputEvents) {
    store.append(event);
    await engine.handleEvent(event);
  }
  const outputEvents = store.all().filter((event) => event.run_id === runId);
  const report = buildReplayReport({
    replayId,
    configHash: params.configHash,
    inputEvents: params.inputEvents,
    outputEvents,
    state,
  });
  return {
    replayId,
    runId,
    state,
    inputEvents: params.inputEvents,
    outputEvents,
    report,
  };
}

export async function runReplayFromJsonl(params: {
  eventPath: string;
  configPath?: string;
  writeReport?: boolean;
}): Promise<ReplayReport> {
  const { config, configHash } = loadConfig(params.configPath);
  config.system.environment = "paper";
  config.alpaca.paper = true;
  const inputEvents = loadJsonlEvents(params.eventPath);
  const { replayId, report } = await runEventsThroughProductionEngine({
    inputEvents,
    config,
    configHash,
    executionAdapter: new SimulatedExecutionAdapter(config),
  });
  if (params.writeReport) {
    mkdirSync(config.replay.report_dir, { recursive: true });
    writeFileSync(join(config.replay.report_dir, `${replayId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
