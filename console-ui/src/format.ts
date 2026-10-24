import type { Signal } from "../../src/console/api-types";

// Times are shown in UTC, like the timestamps in the logs and the pager.
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// "45 s", "4 min 5 s", "1 min", "2 h 3 min", "3 d 4 h": two units at most,
// and no "0 s" or "0 min" tail.
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pair = (big: number, bigUnit: string, small: number, smallUnit: string) =>
    small === 0 ? `${big} ${bigUnit}` : `${big} ${bigUnit} ${small} ${smallUnit}`;
  if (s < 60) return `${s} s`;
  if (s < 3600) return pair(Math.floor(s / 60), "min", s % 60, "s");
  const h = Math.floor(s / 3600);
  if (h < 48) return pair(h, "h", Math.floor((s % 3600) / 60), "min");
  return pair(Math.floor(h / 24), "d", h % 24, "h");
}

// How long ago `iso` was, relative to `now`.
export function formatAge(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return formatDuration((now.getTime() - t) / 1000);
}

export function formatValue(value: number, unit: Signal["unit"]): string {
  switch (unit) {
    case "seconds":
      return formatDuration(value);
    case "events":
      return Math.round(value).toLocaleString("en-US");
    case "ratio":
      return `${(value * 100).toFixed(1)} %`;
  }
}

// What the screen says when Prometheus has no sample for a signal.
export function noValueText(signal: Signal): string {
  if (signal.unit === "ratio") return "no 5xx answers recorded";
  return "no data";
}
