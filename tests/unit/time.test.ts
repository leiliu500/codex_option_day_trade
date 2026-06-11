import test from "node:test";
import assert from "node:assert/strict";
import { formatZonedIso, zonedOffsetMinutes } from "../../src/util/time";

test("formats UTC instants as New York market time with DST offset", () => {
  assert.equal(formatZonedIso("2026-06-10T14:02:01.581Z"), "2026-06-10T10:02:01.581-04:00");
  assert.equal(zonedOffsetMinutes(new Date("2026-06-10T14:02:01.581Z")), -240);
});

test("formats winter instants with standard ET offset", () => {
  assert.equal(formatZonedIso("2026-01-15T15:30:00.000Z"), "2026-01-15T10:30:00.000-05:00");
  assert.equal(zonedOffsetMinutes(new Date("2026-01-15T15:30:00.000Z")), -300);
});
