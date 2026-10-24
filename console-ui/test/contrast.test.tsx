import { describe, expect, it } from "vitest";
import css from "../src/styles.css?raw";

// Every text colour the stylesheet puts on a background, checked against
// WCAG 2.1 AA for normal text (4.5:1).
const PAIRS: [text: string, background: string][] = [
  ["text", "bg"],
  ["text", "surface"],
  ["text", "down-bg"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "down-bg"],
  ["link", "bg"],
  ["link", "down-bg"],
  ["up-text", "up-bg"],
  ["down-text", "down-bg"],
  ["warn-text", "warn-bg"],
  ["on-strong", "primary-bg"],
  ["on-strong", "danger-bg"],
];

function colours(): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("text contrast", () => {
  it("computes the WCAG ratio (black on white is 21:1)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it.each(PAIRS)("--%s on --%s is at least 4.5:1", (text, background) => {
    const c = colours();
    expect(c[text], `--${text} is defined`).toMatch(/^#[0-9a-f]{6}$/);
    expect(c[background], `--${background} is defined`).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(c[text]!, c[background]!)).toBeGreaterThanOrEqual(4.5);
  });
});
