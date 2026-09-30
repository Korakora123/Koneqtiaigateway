/** Parses "HH:MM-HH:MM" (server local time). The window may wrap midnight, e.g. "22:00-06:00". */
export function parseWindow(spec: string): { start: number; end: number } {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  if (!m) throw new Error(`Invalid OFFPEAK_WINDOW: ${spec}`);
  const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new Error(`Invalid OFFPEAK_WINDOW: ${spec}`);
  return { start: h1 * 60 + m1, end: h2 * 60 + m2 };
}

export function isOffPeak(spec: string, now: Date = new Date()): boolean {
  const { start, end } = parseWindow(spec);
  const t = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}
