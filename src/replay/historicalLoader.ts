import type { EventEnvelope } from "../domain/types";
import { loadJsonlEvents } from "../data/eventStore";

export class HistoricalMarketDataLoader {
  loadRecordedEvents(path: string): EventEnvelope[] {
    return loadJsonlEvents(path);
  }
}
