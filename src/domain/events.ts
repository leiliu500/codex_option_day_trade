import { randomUUID } from "node:crypto";
import { nowUtcIso } from "../util/time";
import type { EventEnvelope, EventSource } from "./types";

export class EventFactory {
  private sequence = 0;

  constructor(private readonly runId: string) {}

  next(
    event_type: string,
    source: EventSource,
    normalized: Record<string, unknown>,
    options: {
      raw?: Record<string, unknown>;
      symbol?: string;
      correlation_id?: string;
      event_at_utc?: string;
      received_at_utc?: string;
    } = {},
  ): EventEnvelope {
    this.sequence += 1;
    return {
      event_id: randomUUID(),
      run_id: this.runId,
      event_type,
      source,
      event_at_utc: options.event_at_utc,
      received_at_utc: options.received_at_utc ?? nowUtcIso(),
      sequence_num: this.sequence,
      symbol: options.symbol,
      correlation_id: options.correlation_id,
      raw: options.raw ?? {},
      normalized,
      schema_version: 1,
    };
  }
}
