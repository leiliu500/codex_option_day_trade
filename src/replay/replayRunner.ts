import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { EventFactory } from "../domain/events";
import { LiveState } from "../domain/state";
import { InMemoryEventStore, loadJsonlEvents } from "../data/eventStore";
import { DomainEngine } from "../engine/domainEngine";
import { SimulatedExecutionAdapter } from "../broker/simulatedExecutionAdapter";
import { ReplayClock } from "./replayClock";
import { buildReplayReport, type ReplayReport } from "./reports";

export async function runReplayFromJsonl(params: {
  eventPath: string;
  configPath?: string;
  writeReport?: boolean;
}): Promise<ReplayReport> {
  const { config, configHash } = loadConfig(params.configPath);
  config.system.environment = "paper";
  config.alpaca.paper = true;
  const inputEvents = loadJsonlEvents(params.eventPath);
  const replayId = randomUUID();
  const runId = `replay-${replayId}`;
  const eventFactory = new EventFactory(runId);
  const store = new InMemoryEventStore();
  const state = new LiveState(config);
  const engine = new DomainEngine({
    runId,
    configHash,
    config,
    state,
    eventStore: store,
    eventFactory,
    executionAdapter: new SimulatedExecutionAdapter(config),
  });
  const clock = new ReplayClock(inputEvents[0]?.received_at_utc);
  for (const event of inputEvents) {
    clock.set(event.received_at_utc);
    store.append({ ...event, source: event.source ?? "fixture" });
    await engine.handleEvent(event);
  }
  const outputEvents = store.all().filter((event) => event.run_id === runId);
  const report = buildReplayReport({ replayId, configHash, inputEvents, outputEvents, state });
  if (params.writeReport) {
    mkdirSync(config.replay.report_dir, { recursive: true });
    writeFileSync(join(config.replay.report_dir, `${replayId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
