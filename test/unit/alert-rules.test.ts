import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Checks that tie the alert rules to the runbooks and the receivers. The rule
// logic itself is tested with promtool (observability/prometheus/tests).

const root = join(__dirname, "..", "..");
const RUNBOOK_PREFIX = "https://github.com/muhammad-musa-ml/railcar-telemetry/blob/main/";

interface Rule {
  alert?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function loadAlerts(): Rule[] {
  const dir = join(root, "observability", "prometheus", "rules");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml"))
    .flatMap((f) => parse(readFileSync(join(dir, f), "utf8")).groups.flatMap((g: { rules: Rule[] }) => g.rules))
    .filter((r: Rule) => r.alert !== undefined);
}

describe("alert rules", () => {
  const alerts = loadAlerts();

  it("finds the alerts", () => {
    expect(alerts.length).toBeGreaterThanOrEqual(8);
  });

  it.each(alerts.map((a) => [a.alert!, a]))("%s links to a runbook that exists", (_name, alert) => {
    const url = alert.annotations?.runbook_url ?? "";
    expect(url.startsWith(RUNBOOK_PREFIX)).toBe(true);
    const path = url.slice(RUNBOOK_PREFIX.length);
    expect(path).toMatch(/^docs\/runbooks\/[a-z-]+\.md$/);
    expect(existsSync(join(root, path))).toBe(true);
  });

  it.each(alerts.map((a) => [a.alert!, a]))("%s has a severity the router knows", (_name, alert) => {
    expect(["critical", "warning"]).toContain(alert.labels?.severity);
  });

  it("has a runbook for every alert and no orphan runbooks", () => {
    const linked = new Set(alerts.map((a) => a.annotations!.runbook_url!.split("/").pop()));
    const files = readdirSync(join(root, "docs", "runbooks")).filter((f) => f.endsWith(".md") && f !== "README.md");
    expect(new Set(files)).toEqual(linked);
  });
});
