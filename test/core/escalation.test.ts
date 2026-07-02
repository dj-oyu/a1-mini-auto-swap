// Escalation (spec 13 再通知): unresolved blocking_queue pending actions are
// re-notified once their last notification is older than the escalation
// interval (INV-PENDING-03); resolved actions are never re-notified
// (INV-PENDING-05). Deterministic via the Clock port — no wall-clock waits.
import { beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../src/db/index.ts";
import { Repo } from "../../src/db/repo.ts";
import { EscalationService } from "../../src/core/escalation.ts";
import type { Clock, Notifier, NotifyEvent } from "../../src/core/ports.ts";

const MIN = 60_000;
const INTERVAL_MS = 30 * MIN;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

class FakeClock implements Clock {
  t = T0;
  now(): number {
    return this.t;
  }
}

class RecordingNotifier implements Notifier {
  readonly events: NotifyEvent[] = [];
  notify(e: NotifyEvent): void {
    this.events.push(e);
  }
}

let repo: Repo;
let close: () => void;
let clock: FakeClock;
let notifier: RecordingNotifier;
let svc: EscalationService;

beforeEach(() => {
  const opened = openDb(":memory:");
  repo = opened.repo;
  close = opened.close;
  clock = new FakeClock();
  notifier = new RecordingNotifier();
  svc = new EscalationService(repo, notifier, clock, { intervalMs: INTERVAL_MS });
  return () => close();
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("EscalationService (spec 13 / INV-PENDING-03 / INV-PENDING-05)", () => {
  test("blocking_queue with notified_at older than the interval is re-notified AND notified_at updated (INV-PENDING-03)", () => {
    const id = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
      message: "ストッカーが空です",
    });
    repo.markPendingNotified(id, iso(T0 - INTERVAL_MS - MIN)); // stale by 1 min

    const n = svc.tick();

    expect(n).toBe(1);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]!.type).toBe("pending_action");
    expect(notifier.events[0]!.severity).toBe("blocking_queue");
    const row = repo.getUnresolvedPendingActions().find((a) => a.id === id)!;
    expect(row.notified_at).toBe(iso(T0)); // stamp advanced to "now"
  });

  test("recently notified blocking_queue is NOT re-notified before the interval elapses", () => {
    const id = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
      message: "ストッカーが空です",
    });
    repo.markPendingNotified(id, iso(T0 - INTERVAL_MS + MIN)); // 1 min short of stale

    expect(svc.tick()).toBe(0);
    expect(notifier.events).toHaveLength(0);
  });

  test("re-notification repeats every interval while unresolved (spec 13 escalation loop)", () => {
    const id = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
    });
    repo.markPendingNotified(id, iso(T0 - INTERVAL_MS));

    expect(svc.tick()).toBe(1); // stale at T0 => notify, stamped T0
    expect(svc.tick()).toBe(0); // immediately after: fresh

    clock.t = T0 + INTERVAL_MS; // one interval later
    expect(svc.tick()).toBe(1);
    expect(notifier.events).toHaveLength(2);
  });

  test("resolved pending_action is never re-notified, no matter how old (INV-PENDING-05)", () => {
    const id = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
    });
    repo.markPendingNotified(id, iso(T0 - 10 * INTERVAL_MS));
    repo.resolvePendingAction(id);

    expect(svc.tick()).toBe(0);
    expect(notifier.events).toHaveLength(0);
  });

  test("blocking_job / advisory severities do not escalate (spec 13: only blocking_queue re-notifies)", () => {
    const j = repo.createPendingAction({ type: "retry_decision", severity: "blocking_job" });
    const a = repo.createPendingAction({ type: "filament_confirm", severity: "advisory" });
    repo.markPendingNotified(j, iso(T0 - 10 * INTERVAL_MS));
    repo.markPendingNotified(a, iso(T0 - 10 * INTERVAL_MS));

    expect(svc.tick()).toBe(0);
    expect(notifier.events).toHaveLength(0);
  });

  test("createPendingAction stamps notified_at at creation (creators send the initial notification)", () => {
    const id = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
    });
    const row = repo.getUnresolvedPendingActions().find((x) => x.id === id)!;
    expect(row.notified_at).not.toBeNull();
    // freshly created => not stale => no immediate duplicate re-notification
    expect(svc.tick()).toBe(0);
  });

  test("SQLite 'YYYY-MM-DD HH:MM:SS' timestamps (datetime('now'), UTC) are parsed as UTC, not local time", () => {
    const id = repo.createPendingAction({
      type: "stocker_refill",
      severity: "blocking_queue",
    });
    // Simulate a legacy/DB-stamped value in SQLite's format, exactly one
    // interval before T0: must count as stale regardless of host timezone.
    const d = new Date(T0 - INTERVAL_MS);
    const sqliteFormat = d.toISOString().slice(0, 19).replace("T", " ");
    repo.markPendingNotified(id, sqliteFormat);

    expect(svc.tick()).toBe(1);
  });

  test("carries job/project linkage into the re-notification (deep-link source, INV-PENDING-04)", () => {
    const projectId = repo.createProject("proj", "strict");
    const jobId = repo.createJob({ filename: "plate.gcode.3mf", project_id: projectId });
    const id = repo.createPendingAction({
      type: "color_decision",
      severity: "blocking_queue",
      job_id: jobId,
      project_id: projectId,
      message: "色の判断待ち",
    });
    repo.markPendingNotified(id, iso(T0 - 2 * INTERVAL_MS));

    svc.tick();

    expect(notifier.events[0]!.jobId).toBe(jobId);
    expect(notifier.events[0]!.projectId).toBe(projectId);
    expect(notifier.events[0]!.message).toBe("色の判断待ち");
  });
});
