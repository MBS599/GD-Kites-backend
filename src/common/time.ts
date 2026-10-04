/** Business runs in Pune (IST, UTC+05:30, no DST). */
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the current IST day, as a UTC Date. */
export function startOfToday(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export function startOfYesterday(now = new Date()): Date {
  return new Date(startOfToday(now).getTime() - DAY_MS);
}

/** IST calendar date (YYYY-MM-DD) for grouping reports. */
export function istDateKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Start (as a UTC Date) of the IST calendar day given as YYYY-MM-DD. */
export function istDayStart(key: string): Date {
  return new Date(new Date(`${key}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}
