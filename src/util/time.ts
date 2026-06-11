export const DEFAULT_TIMEZONE = "America/New_York";

export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function secondsFromClock(clock: string): number {
  const [hour, minute, second] = clock.split(":").map((part) => Number.parseInt(part, 10));
  if ([hour, minute, second].some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid ET clock time: ${clock}`);
  }
  return hour * 3600 + minute * 60 + second;
}

export function zonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function secondsSinceMidnightInZone(date: Date, timeZone = DEFAULT_TIMEZONE): number {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}

export function etDateKey(date: Date, timeZone = DEFAULT_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day
    .toString()
    .padStart(2, "0")}`;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [year, month, day] = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function dateKeyDayDiff(startDateKey: string, endDateKey: string): number {
  const [startYear, startMonth, startDay] = parseDateKey(startDateKey);
  const [endYear, endMonth, endDay] = parseDateKey(endDateKey);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.round((end - start) / (24 * 3600 * 1000));
}

export function clockMinusMinutes(clock: string, minutes: number): string {
  const daySeconds = 24 * 3600;
  const target = (secondsFromClock(clock) - minutes * 60 + daySeconds) % daySeconds;
  return secondsToClock(target);
}

export function clockPlusMinutes(clock: string, minutes: number): string {
  const daySeconds = 24 * 3600;
  const target = (secondsFromClock(clock) + minutes * 60) % daySeconds;
  return secondsToClock(target);
}

function secondsToClock(seconds: number): string {
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const second = seconds % 60;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second
    .toString()
    .padStart(2, "0")}`;
}

export function isEtBetween(date: Date, startEt: string, endEt: string, timeZone = DEFAULT_TIMEZONE): boolean {
  const now = secondsSinceMidnightInZone(date, timeZone);
  return now >= secondsFromClock(startEt) && now < secondsFromClock(endEt);
}

export function isEtAtOrAfter(date: Date, clockEt: string, timeZone = DEFAULT_TIMEZONE): boolean {
  return secondsSinceMidnightInZone(date, timeZone) >= secondsFromClock(clockEt);
}

export function secondsBetweenIso(olderIso: string | undefined, newerIso: string): number {
  if (!olderIso) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.parse(newerIso) - Date.parse(olderIso)) / 1000);
}

export function zonedTimeToUtc(dateInZone: Date, clockEt: string, timeZone = DEFAULT_TIMEZONE): Date {
  const parts = zonedParts(dateInZone, timeZone);
  const [hour, minute, second] = clockEt.split(":").map((part) => Number.parseInt(part, 10));
  const targetLocal = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second);
  let utc = targetLocal;
  for (let i = 0; i < 4; i += 1) {
    const observed = zonedParts(new Date(utc), timeZone);
    const observedLocal = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    utc -= observedLocal - targetLocal;
  }
  return new Date(utc);
}

function parseDateKey(dateKey: string): [number, number, number] {
  const parts = dateKey.split("-").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }
  return parts as [number, number, number];
}
