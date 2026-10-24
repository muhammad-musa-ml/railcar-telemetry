import { useState, type FormEvent } from "react";
import type { AlertsResponse, ConsoleAlert, PagesResponse, Signal, StatusResponse } from "../../../src/console/api-types";
import { describeFailure, errorText, postAction } from "../api";
import { formatAge, formatTime, formatValue, noValueText } from "../format";
import { usePolling, type Polled } from "../usePolling";

export const REFRESH_MS = 5000;

function Problem({ polled, what }: { polled: Polled<unknown>; what: string }) {
  if (polled.error === null) return null;
  return (
    <p className="notice notice-error" role="alert">
      Could not load {what}: {polled.error}
      {polled.updatedAt && ` (showing data from ${formatTime(polled.updatedAt.toISOString())})`}
    </p>
  );
}

function Services({ status }: { status: StatusResponse }) {
  if (status.services === null) return <p className="muted">Prometheus could not be asked which services are up.</p>;
  if (status.services.length === 0) return <p className="muted">Prometheus has no scrape targets.</p>;
  return (
    <ul className="tiles">
      {status.services.map((s) => (
        <li key={s.job} className={`tile ${s.up ? "tile-up" : "tile-down"}`}>
          <span className="tile-name">{s.job}</span>
          <span className="tile-state">{s.up ? "up" : "down"}</span>
        </li>
      ))}
    </ul>
  );
}

function SignalRow({ signal }: { signal: Signal }) {
  const threshold = signal.threshold === null ? "" : `${signal.comparison} ${formatValue(signal.threshold, signal.unit)}`;
  return (
    <tr className={signal.breaching ? "row-breaching" : undefined}>
      <th scope="row">{signal.label}</th>
      <td>
        {signal.value === null ? <span className="muted">{noValueText(signal)}</span> : formatValue(signal.value, signal.unit)}
        {signal.breaching && <span className="badge badge-critical">over the alert threshold</span>}
        {signal.error && <span className="muted"> ({signal.error})</span>}
      </td>
      <td>{threshold}</td>
      <td>{signal.runbook_url ? <a href={signal.runbook_url}>{signal.rule}</a> : signal.rule}</td>
    </tr>
  );
}

function SilenceForm({ alert, token, onDone }: { alert: ConsoleAlert; token: string; onDone: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `silence-${alert.fingerprint}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (token === "") {
      setError("Enter your operator token at the top of the page first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await postAction(`/api/alerts/${alert.fingerprint}/silence`, token, {
        reason,
        minutes: Number(minutes),
      });
      if (result.status === 200) {
        onDone(`Silenced ${alert.name} until ${formatTime(String(result.body.ends_at))}.`);
      } else {
        setError(describeFailure(result));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="inline-form" onSubmit={submit} aria-label={`Silence ${alert.name}`}>
      <label htmlFor={`${id}-reason`}>Reason</label>
      <input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} />
      <label htmlFor={`${id}-minutes`}>Minutes (1 to 720)</label>
      <input
        id={`${id}-minutes`}
        type="number"
        min={1}
        max={720}
        step={1}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        required
      />
      <button type="submit" className="button-primary" disabled={busy}>
        {busy ? "Silencing..." : `Silence ${alert.name}`}
      </button>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function AlertItem({ alert, token, now, onSilenced }: { alert: ConsoleAlert; token: string; now: Date; onSilenced: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const canSilence = alert.state === "firing" && !alert.silenced && alert.fingerprint !== null;
  return (
    <li className="alert">
      <div className="alert-head">
        <span className={`badge badge-${alert.severity === "critical" ? "critical" : "warning"}`}>{alert.severity}</span>
        <strong>{alert.name}</strong>
        <span className="muted">
          {alert.state}
          {alert.silenced ? ", silenced" : ""} for {formatAge(alert.since, now)}
        </span>
      </div>
      <p className="alert-summary">{alert.summary}</p>
      <div className="alert-actions">
        {alert.runbook_url && <a href={alert.runbook_url}>Runbook for {alert.name}</a>}
        {canSilence && (
          <button type="button" className="button-secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Cancel" : "Silence..."}
          </button>
        )}
      </div>
      {open && (
        <SilenceForm
          alert={alert}
          token={token}
          onDone={(message) => {
            setOpen(false);
            onSilenced(message);
          }}
        />
      )}
    </li>
  );
}

export function Overview({ token }: { token: string }) {
  const status = usePolling<StatusResponse>("/api/status", REFRESH_MS);
  const alerts = usePolling<AlertsResponse>("/api/alerts", REFRESH_MS);
  const pages = usePolling<PagesResponse>("/api/pages?limit=10", REFRESH_MS);
  const [message, setMessage] = useState<string | null>(null);
  // Alert ages are measured on the console's clock, like everything it reports.
  const now = status.data ? new Date(status.data.generated_at) : new Date();

  return (
    <>
      <p className="live" role="status">
        {message}
      </p>

      <section aria-labelledby="services-heading">
        <h3 id="services-heading">Services</h3>
        <Problem polled={status} what="the pipeline status" />
        {status.loading && <p className="muted">Loading...</p>}
        {status.data && <Services status={status.data} />}
        {status.data && status.data.errors.length > 0 && (
          <p className="notice notice-error">Some sources did not answer: {status.data.errors.join("; ")}</p>
        )}
      </section>

      <section aria-labelledby="pipeline-heading">
        <h3 id="pipeline-heading">Pipeline</h3>
        {status.data && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Signal</th>
                  <th scope="col">Now</th>
                  <th scope="col">Alert when</th>
                  <th scope="col">Alert rule and runbook</th>
                </tr>
              </thead>
              <tbody>
                {status.data.signals.map((s) => (
                  <SignalRow key={s.key} signal={s} />
                ))}
                <tr>
                  <th scope="row">Dead-lettered events</th>
                  <td>{status.data.dead_letters === null ? <span className="muted">Redis did not answer</span> : status.data.dead_letters}</td>
                  <td />
                  <td>
                    <a href="#/dead-letters">Review dead letters</a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="alerts-heading">
        <h3 id="alerts-heading">Alerts</h3>
        <Problem polled={alerts} what="alerts" />
        {alerts.loading && <p className="muted">Loading...</p>}
        {alerts.data && alerts.data.errors.length > 0 && (
          <p className="notice notice-error">Some sources did not answer: {alerts.data.errors.join("; ")}</p>
        )}
        {alerts.data && alerts.data.alerts.length === 0 && <p className="muted">No alerts are firing or pending.</p>}
        {alerts.data && alerts.data.alerts.length > 0 && (
          <ul className="alerts">
            {alerts.data.alerts.map((a) => (
              <AlertItem
                key={a.fingerprint ?? `${a.name}-${a.since}`}
                alert={a}
                token={token}
                now={now}
                onSilenced={(m) => {
                  setMessage(m);
                  alerts.refresh();
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pages-heading">
        <h3 id="pages-heading">Pages and tickets, last 24 hours</h3>
        <Problem polled={pages} what="recent pages" />
        {pages.loading && <p className="muted">Loading...</p>}
        {pages.data && pages.data.pages.length === 0 && <p className="muted">Nothing was paged or ticketed in the last 24 hours.</p>}
        {pages.data && pages.data.pages.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Received</th>
                  <th scope="col">Alert</th>
                  <th scope="col">Status</th>
                  <th scope="col">Sent as</th>
                </tr>
              </thead>
              <tbody>
                {pages.data.pages.map((p, i) => (
                  <tr key={`${p.received_at}-${p.alertname}-${i}`}>
                    <td>{formatTime(p.received_at)}</td>
                    <td>
                      {p.runbook_url ? <a href={p.runbook_url}>{p.alertname}</a> : p.alertname}
                      <span className="muted"> ({p.severity})</span>
                    </td>
                    <td>{p.status}</td>
                    <td>{p.receiver}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
