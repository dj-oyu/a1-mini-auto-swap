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

describe("Dispatcher — stocker empty (INV-STOCKER-04)", () => {
  test("no dispatch, creates stocker_refill(blocking_queue); refill unblocks", async () => {
    dbh.repo.setStocker(5, 0);
    const id = queuedJob("a");
    const out = await dispatcher.dispatchNext();
    expect(out).toEqual({ dispatched: null, reason: "stocker_empty" });
    expect(printingCount()).toBe(0);
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
    expect(dbh.repo.getStocker()!.remaining).toBe(9); // forced-eject swap
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
