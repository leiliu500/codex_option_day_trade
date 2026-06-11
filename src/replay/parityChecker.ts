import type { EventEnvelope } from "../domain/types";

export interface ParityExpectation {
  event_type: string;
  count: number;
}

export function checkEventCountParity(events: EventEnvelope[], expectations: ParityExpectation[]): string[] {
  const mismatches: string[] = [];
  for (const expectation of expectations) {
    const actual = events.filter((event) => event.event_type === expectation.event_type).length;
    if (actual !== expectation.count) {
      mismatches.push(`${expectation.event_type}: expected ${expectation.count}, got ${actual}`);
    }
  }
  return mismatches;
}
