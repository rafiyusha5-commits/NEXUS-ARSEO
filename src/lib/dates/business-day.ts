// The business day of ARSEO is Kazakhstan's (UTC+5), the same day the database uses (202609278300). The server and
// the browser may run in UTC, where from 00:00 to 05:00 in Kazakhstan it is still yesterday.
export const BUSINESS_TIME_ZONE = "Asia/Almaty";

/** Today's date in Kazakhstan as YYYY-MM-DD, for date inputs and comparisons with dates from the database. */
export function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Difference between calendar dates, independent of the host time zone or time of day. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function businessDaysRemaining(expiry: string, now: Date = new Date()): number {
  return calendarDaysBetween(businessToday(now), expiry);
}
