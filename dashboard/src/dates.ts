/**
 * ISO-date arithmetic on `YYYY-MM-DD` strings, always in UTC.
 *
 * Why strings and UTC: the tables store days, not instants. Doing the maths on
 * local-time `Date`s shifts days around midnight and across daylight-saving
 * changes; doing it on UTC midnights never does.
 */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` -> milliseconds at UTC midnight. */
export const toMs = (iso: string): number => Date.parse(iso + "T00:00:00Z");

/** Milliseconds -> `YYYY-MM-DD` (UTC). */
export const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Day `iso` plus `n` days (n may be negative). */
export const addDays = (iso: string, n: number): string => fromMs(toMs(iso) + n * DAY_MS);

/** Whole days from `a` to `b` (b - a). */
export const daysBetween = (a: string, b: string): number => Math.round((toMs(b) - toMs(a)) / DAY_MS);

/** Every day from `start` to `end`, inclusive. */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let ms = toMs(start), last = toMs(end); ms <= last; ms += DAY_MS) out.push(fromMs(ms));
  return out;
}

/** The Monday starting the ISO week that contains `iso`. */
export function weekStart(iso: string): string {
  const d = new Date(toMs(iso));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  return addDays(iso, -dow);
}

/** The first day of the month that contains `iso`. */
export const monthStart = (iso: string): string => iso.slice(0, 7) + "-01";

/** The last day of the month that contains `iso`. */
export function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return fromMs(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
}

/** Today's date in UTC. Injected where tested. */
export const todayUtc = (): string => fromMs(Date.now());

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 3" (or "Mar 3, 2026" with `year`). */
export function fmtDay(iso: string, { year = false } = {}): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}${year ? `, ${y}` : ""}`;
}

/** "Mar 2026" (or "Mar '26" when `short`). */
export function fmtMonth(iso: string, { short = false } = {}): string {
  const [y, m] = iso.split("-").map(Number);
  return short ? `${MONTHS[m - 1]} '${String(y).slice(2)}` : `${MONTHS[m - 1]} ${y}`;
}

/** "Mar 3 – Mar 9, 2026", collapsing a one-day span to one date. */
export function fmtSpan(start: string, end: string): string {
  if (start === end) return fmtDay(start, { year: true });
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${fmtDay(start, { year: !sameYear })} – ${fmtDay(end, { year: true })}`;
}
