import { useState, type FormEvent } from "react";
import type { DeadLetter, DeadLettersResponse } from "../../../src/console/api-types";
import { describeFailure, errorText, postAction } from "../api";
import { formatTime } from "../format";
import { usePolling } from "../usePolling";
import { REFRESH_MS } from "./Overview";

type Action = "replay" | "discard";

interface Refusal {
  message: string;
  issues: { path: string; message: string }[];
  stillDeadLettered: boolean;
}

const QUESTION: Record<Action, string> = {
  replay:
    "Put this event back into railcar:events? It is checked against the current event schema first, and refused if it would fail again.",
  discard: "Remove this event from the dead-letter stream for good? The audit record keeps a copy of it.",
};

function DeadLetterItem({ entry, token, onDone }: { entry: DeadLetter; token: string; onDone: (message: string) => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const formId = `dl-${entry.id}`;

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (action === null) return;
    if (token === "") {
      setRefusal({ message: "Enter your operator token at the top of the page first.", issues: [], stillDeadLettered: true });
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      const body = reason.trim() === "" && action === "replay" ? {} : { reason };
      const result = await postAction(`/api/dead-letters/${encodeURIComponent(entry.id)}/${action}`, token, body);
      if (result.status === 200) {
        onDone(
          action === "replay"
            ? `Replayed ${entry.id}. It is back in railcar:events as ${String(result.body.stream_id)}.`
            : `Discarded ${entry.id}.`,
        );
        return;
      }
      setRefusal({
        message: result.status === 422 ? `Replay refused: ${result.body.error ?? "the event fails the current schema"}` : describeFailure(result),
        issues: result.body.issues ?? [],
        stillDeadLettered: result.status !== 404,
      });
      // A schema refusal would only repeat, so the confirm step closes. For
      // anything else (token, rate limit, audit log down) it stays open with
      // what was typed, to try again.
      if (result.status === 422) setAction(null);
    } catch (err) {
      setRefusal({ message: errorText(err), issues: [], stillDeadLettered: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="dead-letter">
      <dl className="facts">
        <dt>Id</dt>
        <dd>
          <code>{entry.id}</code>
        </dd>
        <dt>Dead-lettered</dt>
        <dd>{formatTime(entry.dead_lettered_at)}</dd>
        <dt>Stream entry</dt>
        <dd>
          <code>{entry.source_id || "unknown"}</code>
        </dd>
        <dt>Reason</dt>
        <dd>{entry.reason || "none given"}</dd>
      </dl>
      <pre className="event" aria-label={`Stored event ${entry.id}`}>
        <code>{entry.event}</code>
      </pre>

      {refusal && (
        <div className="notice notice-error" role="alert">
          <p>{refusal.message}</p>
          {refusal.issues.length > 0 && (
            <ul>
              {refusal.issues.map((issue, i) => (
                <li key={i}>
                  <code>{issue.path || "event"}</code>: {issue.message}
                </li>
              ))}
            </ul>
          )}
          {refusal.stillDeadLettered && <p>The event is still in the dead-letter stream.</p>}
        </div>
      )}

      {action === null ? (
        <div className="row-actions">
          <button type="button" className="button-secondary" onClick={() => setAction("replay")}>
            Replay {entry.id}...
          </button>
          <button type="button" className="button-secondary" onClick={() => setAction("discard")}>
            Discard {entry.id}...
          </button>
        </div>
      ) : (
        <form className="inline-form confirm" onSubmit={confirm} aria-label={`Confirm ${action} of ${entry.id}`}>
          <p>{QUESTION[action]}</p>
          <label htmlFor={`${formId}-reason`}>{action === "discard" ? "Reason (required)" : "Reason (optional)"}</label>
          <input
            id={`${formId}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required={action === "discard"}
            minLength={3}
            maxLength={500}
            autoFocus
          />
          <button type="submit" className={action === "discard" ? "button-danger" : "button-primary"} disabled={busy}>
            {busy ? "Working..." : action === "replay" ? "Confirm replay" : "Confirm discard"}
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setAction(null);
              setRefusal(null);
            }}
          >
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}

export function DeadLetters({ token }: { token: string }) {
  const list = usePolling<DeadLettersResponse>("/api/dead-letters?limit=100", REFRESH_MS);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <>
      <p>
        Events the tracker could not write, from the Redis stream <code>railcar:events:dead</code>, newest first. See the{" "}
        <a href="https://github.com/muhammad-musa-ml/railcar-telemetry/blob/main/docs/runbooks/dead-lettered-events.md">
          dead-lettered events runbook
        </a>{" "}
        before replaying or discarding.
      </p>
      <p className="live" role="status">
        {message}
      </p>
      {list.error && (
        <p className="notice notice-error" role="alert">
          Could not load the dead-letter stream: {list.error}
        </p>
      )}
      {list.loading && <p className="muted">Loading...</p>}
      {list.data && list.data.count === 0 && <p className="muted">The dead-letter stream is empty.</p>}
      {list.data && list.data.count > 0 && (
        <>
          <p>
            {list.data.count} {list.data.count === 1 ? "entry" : "entries"}
            {list.data.count > list.data.entries.length && `, showing the newest ${list.data.entries.length}`}.
          </p>
          <ul className="dead-letters">
            {list.data.entries.map((entry) => (
              <DeadLetterItem
                key={entry.id}
                entry={entry}
                token={token}
                onDone={(m) => {
                  setMessage(m);
                  list.refresh();
                }}
              />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
