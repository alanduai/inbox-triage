function parts(date: Date, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** "2026-10-23 10:12" in the given time zone. */
export function localStamp(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

/** "2026-10-23T10:12" in the given time zone (the same shape the triage uses for reply_by). */
export function localIso(date: Date, tz: string): string {
  return localStamp(date, tz).replace(" ", "T");
}

/** Minutes the zone is ahead of UTC at that instant (120 for Zagreb in summer). */
export function offsetMinutes(date: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A real calendar date, YYYY-MM-DD (no 30 February). */
export function isValidDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number(m[1]) >= 2000 && d.toISOString().slice(0, 10) === s;
}

/**
 * The instant a local wall-clock time in tz means. When the clocks go back and the time occurs
 * twice, the earlier instant is used (the safer choice for a deadline); a time skipped when the
 * clocks go forward moves to the first valid time after it.
 */
export function localToUtc(local: string, tz: string): Date | null {
  const m = local.match(LOCAL);
  if (!m || !isValidDate(local.slice(0, 10)) || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const offsets = new Set([offsetMinutes(new Date(asUtc - 12 * 3_600_000), tz), offsetMinutes(new Date(asUtc + 12 * 3_600_000), tz)]);
  const candidates = [...offsets].map((o) => asUtc - o * 60_000).sort((a, b) => a - b);
  const exact = candidates.find((c) => localIso(new Date(c), tz) === local);
  if (exact !== undefined) return new Date(exact);
  return new Date(Math.max(...candidates));
}

/**
 * A model-written date-time as local "YYYY-MM-DDTHH:MM" in tz, or "" if it is not a real time.
 * Accepts seconds, a space instead of T, and an explicit offset or Z (converted to tz).
 */
export function normalizeLocalDateTime(value: string, tz: string): string {
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return "";
  const local = `${m[1]}T${m[2]}:${m[3]}`;
  if (!localToUtc(local, tz) && !m[4]) return "";
  if (m[4]) {
    const instant = new Date(`${local}:00${m[4].toUpperCase() === "Z" ? "Z" : m[4].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2")}`);
    return Number.isNaN(instant.getTime()) || !isValidDate(m[1]!) ? "" : localIso(instant, tz);
  }
  return local;
}

export function log(message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra instanceof Error ? extra.message : extra);
}
