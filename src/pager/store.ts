import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// Append-only JSON-lines file, read back into memory at startup so the
// history survives a restart of the pager.
export class JsonlLog<T extends { received_at: string }> {
  private readonly records: T[] = [];

  constructor(private readonly path: string | null) {
    if (path === null) return;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim() !== "") {
          this.records.push(JSON.parse(line) as T);
        }
      }
    }
  }

  // Written to disk first: if the write fails the caller gets the error (and
  // Alertmanager retries), and the record is not half-kept in memory only.
  append(record: T): void {
    if (this.path !== null) {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    }
    this.records.push(record);
  }

  // Records received at or after `since` (an ISO timestamp).
  since(since?: string): T[] {
    if (!since) return [...this.records];
    const cutoff = Date.parse(since);
    return this.records.filter((r) => Date.parse(r.received_at) >= cutoff);
  }
}
