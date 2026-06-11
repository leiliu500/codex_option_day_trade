import { randomUUID } from "node:crypto";
import { DEFAULT_TIMEZONE, formatZonedIso, nowUtcIso } from "../util/time";
import type { EventEnvelope, EventSource } from "./types";

export class EventFactory {
  private sequence = 0;

  constructor(
    private readonly runId: string,
    private readonly timeZone = DEFAULT_TIMEZONE,
  ) {}

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
    const receivedAtUtc = options.received_at_utc ?? nowUtcIso();
    const eventAtUtc = options.event_at_utc;
    return {
      event_id: randomUUID(),
      run_id: this.runId,
      event_type,
      source,
      event_at_utc: eventAtUtc,
      event_at_et: eventAtUtc === undefined ? undefined : formatZonedIso(eventAtUtc, this.timeZone),
      received_at_utc: receivedAtUtc,
      received_at_et: formatZonedIso(receivedAtUtc, this.timeZone),
      sequence_num: this.sequence,
      symbol: options.symbol,
      correlation_id: options.correlation_id,
      raw: options.raw ?? {},
      normalized,
      schema_version: 1,
    };
  }
}
