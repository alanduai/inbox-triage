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

export function log(message: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra instanceof Error ? extra.message : extra);
}
