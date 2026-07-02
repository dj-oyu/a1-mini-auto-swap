import { beforeEach, describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../src/db/index.ts";
import { Dispatcher } from "../../src/core/dispatcher.ts";
import type { PrinterPort } from "../../src/core/ports.ts";
import type { JobRow } from "../../src/db/types.ts";

class FakePrinter implements PrinterPort {
  started: number[] = [];
  ejects = 0;
  async startPrint(job: JobRow): Promise<void> {
    this.started.push(job.id);
  }
  async ejectAndReset(): Promise<void> {
    this.ejects++;
  }
  async resumeWithAlternateSlot(): Promise<void> {}
}

let dbh: Db;
let printer: FakePrinter;
let dispatcher: Dispatcher;

beforeEach(() => {
  dbh = openDb(":memory:");
  printer = new FakePrinter();
  dispatcher = new Dispatcher(dbh.repo, printer, { retryLimit: 3 });
  dbh.repo.setStocker(10, 10);
});

function queuedJob(filename: string, projectId?: number): number {
  const id = dbh.repo.createJob({ filename, project_id: projectId ?? null });
  dbh.repo.updateStatus(id, "queued");
  return id;
}
const printingCount = () => dbh.repo.listByStatus("printing").length;

describe("Dispatcher — single job", () => {
  test("dispatches a queued job to printing and starts the printer", async () => {
    const id = queuedJob("a.3mf");
    const out = await dispatcher.dispatchNext();
    expect(out).toEqual({ dispatched: id });
    expect(dbh.repo.getJob(id)!.status).toBe("printing");
    expect(printer.started).toEqual([id]);
  });

  test("onFinished => success, stocker -1, auto-advance (INV-STOCKER-02)", async () => {
    const id = queuedJob("a.3mf");
    await dispatcher.dispatchNext();
    await dispatcher.onFinished(id);
    expect(dbh.repo.getJob(id)!.status).toBe("success");
    expect(dbh.repo.getStocker()!.remaining).toBe(9);
    expect(printingCount()).toBe(0);
  });

  // INV-RUNOUT-02 (machine-layer proxy; the wording itself is the AI layer):
  // a silently-substituted color must surface in the completion notice —
  // spec 14 "サイレントに色が変わったことに後から気づく事故を防ぐ".
  test("onFinished after a color substitution: the job_finished notification mentions it (INV-RUNOUT-02)", async () => {
    const events: Array<{ type: string; message?: string; severity?: string }> = [];
    dispatcher = new Dispatcher(dbh.repo, printer, {
      notifier: { notify: (e) => events.push(e) },
    });
    const id = queuedJob("a.3mf");
    await dispatcher.dispatchNext();
    dbh.repo.setSubstitution(id, 1, "#0000FF");

    await dispatcher.onFinished(id);

    const finish = events.filter((e) => e.type === "job_finished");
    expect(finish).toHaveLength(1);
    expect(finish[0]!.message).toContain("自動切替");
    expect(finish[0]!.message).toContain("#0000FF");
  });

  test("onFinished without a substitution: the job_finished notification carries no substitution notice", async () => {
    const events: Array<{ type: string; message?: string }> = [];
    dispatcher = new Dispatcher(dbh.repo, printer, {
      notifier: { notify: (e) => events.push(e) },
    });
    const id = queuedJob("a.3mf");
    await dispatcher.dispatchNext();
    await dispatcher.onFinished(id);
    const finish = events.filter((e) => e.type === "job_finished");
    expect(finish).toHaveLength(1);
    expect(finish[0]!.message ?? "").not.toContain("自動切替");
  });
});

describe("Dispatcher — sequencing (INV-DISPATCH-02/03)", () => {
  test("one printing at a time; finishes advance in position order; stocker steps down", async () => {
    const a = queuedJob("a");
    const b = queuedJob("b");
    const c = queuedJob("c");

    expect(await dispatcher.dispatchNext()).toEqual({ dispatched: a });
    expect(await dispatcher.dispatchNext()).toEqual({ dispatched: null, reason: "busy" });
    expect(printingCount()).toBe(1);

    await dispatcher.onFinished(a);
    expect(dbh.repo.getJob(b)!.status).toBe("printing"); // auto-advanced to b
    await dispatcher.onFinished(b);
    expect(dbh.repo.getJob(c)!.status).toBe("printing");
    await dispatcher.onFinished(c);

    expect(printingCount()).toBe(0);
    expect(dbh.repo.getStocker()!.remaining).toBe(7);
    expect(printer.started).toEqual([a, b, c]);
  });
});

describe("Dispatcher — abort (spec 8/19)", () => {
  test("aborts the running plate: eject, aborted, swap -1, auto-advance", async () => {
    const a = queuedJob("a");
    const b = queuedJob("b");
    await dispatcher.dispatchNext(); // a printing
    expect(dbh.repo.getJob(a)!.status).toBe("printing");

    const ok = await dispatcher.abort(a);
    expect(ok).toBe(true);
    // INV-MQTT-02 (indirect, core-layer equivalent): abort issues the eject/reset sequence
    // before the mechanism is considered safe again; the MQTT stop->eject-job ordering itself
    // is verified at the orchestrator layer, not here.
    expect(printer.ejects).toBe(1); // mechanism reset
    expect(dbh.repo.getJob(a)!.status).toBe("aborted");
    expect(dbh.repo.getStocker()!.remaining).toBe(9); // forced eject swap (-1)
    expect(dbh.repo.getJob(b)!.status).toBe("printing"); // auto-advanced to b
  });

  test("is a no-op for a job that isn't printing", async () => {
    const a = queuedJob("a"); // queued, not printing
    expect(await dispatcher.abort(a)).toBe(false);
    expect(dbh.repo.getJob(a)!.status).toBe("queued");
    expect(printer.ejects).toBe(0);
  });
});

describe("Dispatcher — low-stock early warning (spec 13)", () => {
  test("advisory heads-up when a swap crosses the low-water mark; 'last plate' at 0", async () => {
    const events: Array<{ type: string; severity?: string; message?: string }> = [];
    const notifier = { notify: (e: { type: string; severity?: string; message?: string }) => events.push(e) };
    dispatcher = new Dispatcher(dbh.repo, printer, { notifier, lowStockThreshold: 1 });
    dbh.repo.setStocker(3, 2); // 2 spares

    const a = queuedJob("a");
    const b = queuedJob("b");
    await dispatcher.dispatchNext(); // a printing; no swap yet
    expect(events.filter((e) => e.type === "stocker_low")).toHaveLength(0);

    await dispatcher.onFinished(a); // swap → remaining 1 → warn "残り1枚"
    let low = events.filter((e) => e.type === "stocker_low");
    expect(low).toHaveLength(1);
    expect(low[0]!.severity).toBe("advisory"); // whisper, not blocking
    expect(low[0]!.message).toContain("1枚");

    await dispatcher.onFinished(b); // swap → remaining 0 → "last plate on the bed"
    low = events.filter((e) => e.type === "stocker_low");
    expect(low).toHaveLength(2);
    expect(low[1]!.message).toContain("最後");
  });

  test("no warning while spares stay above the threshold", async () => {
    const events: string[] = [];
    dispatcher = new Dispatcher(dbh.repo, printer, {
      notifier: { notify: (e) => events.push(e.type) },
      lowStockThreshold: 1,
    });
    dbh.repo.setStocker(10, 10);
    const a = queuedJob("a");
    await dispatcher.dispatchNext();
    await dispatcher.onFinished(a); // remaining 9 — well above threshold
    expect(events).not.toContain("stocker_low");
  });
});

describe("Dispatcher — stocker empty (INV-STOCKER-04)", () => {
  test("no dispatch, creates stocker_refill(blocking_queue); refill unblocks", async () => {
    dbh.repo.setStocker(5, 0);
    const id = queuedJob("a");
    const out = await dispatcher.dispatchNext();
    expect(out).toEqual({ dispatched: null, reason: "stocker_empty" });
    expect(printingCount()).toBe(0);
    // INV-DISPATCH-04: stocker-check fails => no FTPS upload / print_start reaches the printer port
    expect(printer.started).toHaveLength(0);
    const pending = dbh.repo.getUnresolvedPendingActions();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.type).toBe("stocker_refill");
    expect(pending[0]!.severity).toBe("blocking_queue");

    // refill + resolve, then it dispatches
    dbh.repo.refillStocker();
    dbh.repo.resolvePendingAction(pending[0]!.id);
    expect(await dispatcher.dispatchNext()).toEqual({ dispatched: id });
  });

  test("does not create a duplicate stocker_refill on repeated attempts", async () => {
    dbh.repo.setStocker(5, 0);
    queuedJob("a");
    await dispatcher.dispatchNext();
    await dispatcher.dispatchNext();
    expect(dbh.repo.getUnresolvedPendingActions()).toHaveLength(1);
    // INV-DISPATCH-04: repeated attempts while stocker is empty must never call startPrint
    expect(printer.started).toHaveLength(0);
  });
});

describe("Dispatcher — project blocking (INV-DISPATCH-01)", () => {
  test("a project blocked on color_decision does not block other projects' jobs", async () => {
    const projA = dbh.repo.createProject("A");
    const projB = dbh.repo.createProject("B");
    const a1 = queuedJob("a1", projA); // lower position, but blocked
    const b1 = queuedJob("b1", projB);
    dbh.repo.createPendingAction({ type: "color_decision", severity: "blocking_job", project_id: projA });

    const out = await dispatcher.dispatchNext();
    expect(out).toEqual({ dispatched: b1 }); // skipped a1, ran b1
    expect(dbh.repo.getJob(a1)!.status).toBe("queued"); // still waiting
    // INV-DISPATCH-04: project-block-check fails for a1 => startPrint is never called for it,
    // even though it sorts before b1 (INV-DISPATCH-02 position order would otherwise pick it first)
    expect(printer.started).toEqual([b1]);
  });
});

describe("Dispatcher — blocking_queue freezes dispatch (INV-CONSISTENCY-02)", () => {
  test("any unresolved blocking_queue pending stops all dispatch", async () => {
    queuedJob("a");
    dbh.repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue", message: "x" });
    expect(await dispatcher.dispatchNext()).toEqual({ dispatched: null, reason: "blocked_queue" });
    expect(printingCount()).toBe(0);
  });
});

describe("Dispatcher — failure & retry (INV-FAIL-01 / INV-QUEUE-02/03)", () => {
  test("onFailed => failed + eject + swap + retry_decision, no auto-retry", async () => {
    const id = queuedJob("a");
    await dispatcher.dispatchNext();
    await dispatcher.onFailed(id, "HMS 0x0C000001");

    const job = dbh.repo.getJob(id)!;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(printer.ejects).toBe(1);
    // INV-FAIL-02: onFailed still consumes a stocker plate (forced-eject swap), so a swap-system
    // fault surfaces as a stocker/consumption discrepancy instead of being silently lost
    expect(dbh.repo.getStocker()!.remaining).toBe(9);
    expect(dbh.repo.getUnresolvedPendingActions().some((a) => a.type === "retry_decision")).toBe(true);

    // failed job is NOT re-dispatched automatically
    const out = await dispatcher.dispatchNext();
    expect(out).toEqual({ dispatched: null, reason: "no_eligible_job" });
  });

  test("retry re-queues within the cap and halts (notify-only) beyond it", async () => {
    const id = queuedJob("a");
    // simulate 4 prior attempts (> retryLimit 3)
    for (let i = 0; i < 4; i++) dbh.repo.incrementAttempts(id);
    dbh.repo.updateStatus(id, "failed");
    // INV-QUEUE-03: attempts > retryLimit => queue halts for this job, notify-only, no auto re-dispatch
    expect(await dispatcher.retry(id)).toBe(false);
    expect(dbh.repo.getJob(id)!.status).toBe("failed");
    expect(dbh.repo.getUnresolvedPendingActions().some((a) => a.type === "mechanical_check")).toBe(true);

    // within cap: re-queues
    const id2 = queuedJob("b");
    dbh.repo.updateStatus(id2, "failed");
    expect(await dispatcher.retry(id2)).toBe(true);
    expect(dbh.repo.getJob(id2)!.status).toBe("queued");
  });
});
