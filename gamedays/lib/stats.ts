// Small helpers for summarising repeated drill runs. Every summary reports
// the median and the full range, never a single run.

export interface Spread {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function spread(values: (number | null | undefined)[]): Spread {
  const present = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0) {
    return { n: 0, median: null, min: null, max: null };
  }
  return {
    n: present.length,
    median: median(present),
    min: Math.min(...present),
    max: Math.max(...present),
  };
}

export function seconds(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
}

export function round(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
