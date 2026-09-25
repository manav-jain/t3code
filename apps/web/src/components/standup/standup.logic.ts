import type { StandupDayInput } from "@t3tools/contracts";

/** A local calendar day, `YYYY-MM-DD`, so days compare as strings. */
export type StandupDayKey = string;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const pad = (value: number) => String(value).padStart(2, "0");

export function localDay(date: Date): StandupDayKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayDate = (day: StandupDayKey, offset = 0) => {
  const [year, month, date] = day.split("-").map(Number);
  // Date normalizes overflow, so month ends and DST days need no special handling.
  return new Date(year!, month! - 1, date! + offset);
};

export function isStandupDay(value: unknown): value is StandupDayKey {
  return typeof value === "string" && DAY_PATTERN.test(value) && localDay(dayDate(value)) === value;
}

export function shiftDay(day: StandupDayKey, delta: number): StandupDayKey {
  return localDay(dayDate(day, delta));
}

/** The day from local midnight to the next, which DST can make 23 or 25 hours. */
export function dayWindow(day: StandupDayKey): StandupDayInput {
  return { from: dayDate(day).toISOString(), to: dayDate(day, 1).toISOString() };
}

export function dayLabel(day: StandupDayKey, today: StandupDayKey): string {
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  const date = dayDate(day);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(date.getFullYear() === dayDate(today).getFullYear() ? {} : { year: "numeric" }),
  });
}
