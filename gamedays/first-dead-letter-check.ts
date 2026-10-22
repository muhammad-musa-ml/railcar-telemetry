import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { compose, gitCommit, pager, redisCli, repoRoot } from "./lib/clients";
import { round, seconds } from "./lib/stats";

// One check, not a drill: restart the tracker, write one event it must
// dead-letter, and see whether DeadLetteredEvents opens a ticket. Before the
// tracker exported its counters at 0, the first dead letter after a start
// was invisible to the alert (docs/incidents/004-poison-event.md).
//
//   npx tsx gamedays/first-dead-letter-check.ts

async function main() {
  await compose("restart", "tracker");
  const restarted = await pager.mark("check-tracker-restarted");
  // Let Prometheus scrape the fresh counters a few times first.
  await sleep(30_000);
  const event = {
    event_id: randomUUID(),
    car_id: "RCTX 100001",
    reader_id: "AEI-YD04-E",
    location: "YD04\u0000",
    observed_at: new Date().toISOString(),
  };
  const injected = await pager.mark("check-inject");
  const [id] = await redisCli("XADD", "railcar:events", "*", "event", JSON.stringify(event));

  let ticketAt: string | null = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && ticketAt === null) {
    const pages = await pager.pages(injected.received_at);
    ticketAt = pages.find((p) => p.alertname === "DeadLetteredEvents" && p.status === "firing")?.received_at ?? null;
    if (ticketAt === null) await sleep(1000);
  }

  const result = {
    note: "single check, not a drill: first dead letter after a tracker restart",
    git_commit: await gitCommit(),
    tracker_restarted_at: restarted.received_at,
    injected_at: injected.received_at,
    stream_id: id,
    ticket_received: ticketAt !== null,
    ticket_after_injection_s: ticketAt ? round(seconds(injected.received_at, ticketAt)) : null,
  };
  mkdirSync(join(repoRoot, "results", "evidence"), { recursive: true });
  writeFileSync(join(repoRoot, "results", "evidence", "first-dead-letter-after-restart.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
