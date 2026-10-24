// Shapes of the console's HTTP responses. The browser code in console-ui/
// imports these types, so this file must not import anything.

export interface ServiceStatus {
  job: string;
  up: boolean;
}

export type SignalUnit = "seconds" | "events" | "ratio";

// One number from the pipeline, computed with the expression of the alert
// rule that watches it, next to that rule's threshold.
export interface Signal {
  key: string;
  label: string;
  unit: SignalUnit;
  rule: string;
  // null when Prometheus has no sample (for example an error ratio with no
  // traffic, or freshness while Postgres is unreachable).
  value: number | null;
  comparison: string | null;
  threshold: number | null;
  // The rule's condition holds right now. The alert fires once it has held
  // for the rule's `for` window.
  breaching: boolean;
  runbook_url: string | null;
  error?: string;
}

export interface StatusResponse {
  generated_at: string;
  // null when Prometheus could not be asked.
  services: ServiceStatus[] | null;
  signals: Signal[];
  // Entries in the dead-letter stream; null when Redis could not be asked.
  dead_letters: number | null;
  errors: string[];
}

export interface ConsoleAlert {
  // Alertmanager's fingerprint, needed to silence the alert. Pending alerts
  // come from Prometheus and have none.
  fingerprint: string | null;
  name: string;
  state: "firing" | "pending";
  silenced: boolean;
  severity: string;
  summary: string;
  runbook_url: string | null;
  since: string;
  labels: Record<string, string>;
}

export interface AlertsResponse {
  alerts: ConsoleAlert[];
  errors: string[];
}

export interface PageSummary {
  received_at: string;
  receiver: string;
  status: string;
  alertname: string;
  severity: string;
  summary: string;
  runbook_url: string;
}

export interface PagesResponse {
  pages: PageSummary[];
}

export interface DeadLetter {
  id: string;
  // Id of the entry in railcar:events that was moved here.
  source_id: string;
  reason: string;
  // The event exactly as it was stored, which may not be valid JSON.
  event: string;
  dead_lettered_at: string;
}

export interface DeadLettersResponse {
  count: number;
  entries: DeadLetter[];
}

export interface CarPosition {
  car_id: string;
  location: string;
  reader_id: string;
  arrived_at: string;
  last_seen_at: string;
  dwell_seconds: number;
}

export interface LocationCarsResponse {
  location: string;
  cars: CarPosition[];
}

export interface ErrorResponse {
  error: string;
  issues?: { path: string; message: string }[];
}
