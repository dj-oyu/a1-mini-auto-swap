import { beforeEach, describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../src/db/index.ts";
import { Dispatcher } from "../../src/core/dispatcher.ts";
import type { PrinterPort } from "../../src/core/ports.ts";
import type { JobRow } from "../../src/db/types.ts";

class FakePrinter implements PrinterPort {
  started: number[] = [];
  async startPrint(job: JobRow): Promise<void> {
    this.started.push(job.id);
  }
  async ejectAndReset(): Promise<void> {}
  async resumeWithAlternateSlot(): Promise<void> {}
}

let dbh: Db;
let dispatcher: Dispatcher;
const BLUE = "#0000FF";

beforeEach(() => {
  dbh = openDb(":memory:");
  dispatcher = new Dispatcher(dbh.repo, new FakePrinter());
  dbh.repo.setStocker(10, 10);
});

function queued(filename: string, projectId?: number): number {
  const id = dbh.repo.createJob({ filename, project_id: projectId ?? null });
  dbh.repo.updateStatus(id, "queued");
  return id;
}

describe("dispatcher color-consistency (spec 12)", () => {
  test("strict: a substituted plate creates color_decision and pauses only that project (INV-PROJECT-01 / INV-DISPATCH-01)", async () => {
    const proj = dbh.repo.createProject("P", "strict");
    const a = queued("a", proj);
    const b = queued("b", proj); // same project — must be paused
    const c = queued("c"); // no project — must proceed

    // A is printing and substituted a color
    dbh.repo.updateStatus(a, "printing");
    dbh.repo.setSubstitution(a, 1, BLUE);

    await dispatcher.onFinished(a);

    expect(dbh.repo.getUnresolvedPendingActions().some((p) => p.type === "color_decision")).toBe(true);
    // onFinished auto-advanced: B (blocked project) skipped, C dispatched
    expect(dbh.repo.getJob(c)!.status).toBe("printing");
    expect(dbh.repo.getJob(b)!.status).toBe("queued");
  });

  test("propagate: substitute color applied to remaining same-project plates, no block (INV-PROJECT-02)", async () => {
    const proj = dbh.repo.createProject("P", "propagate");
    const a = queued("a", proj);
    const b = queued("b", proj);
    const c = queued("c", proj);

    dbh.repo.updateStatus(a, "printing");
    dbh.repo.setSubstitution(a, 1, BLUE);

    await dispatcher.onFinished(a);

    expect(dbh.repo.getUnresolvedPendingActions().some((p) => p.type === "color_decision")).toBe(false);
    expect(dbh.repo.getJob(b)!.substituted_color).toBe(BLUE);
    expect(dbh.repo.getJob(c)!.substituted_color).toBe(BLUE);
    expect(dbh.repo.getJob(b)!.substituted_slot).toBe(1);
    // and it keeps flowing — B dispatched
    expect(dbh.repo.getJob(b)!.status).toBe("printing");
  });

  test("no project: substitution does not trigger color handling (INV-PROJECT-03)", async () => {
    const a = queued("a"); // no project
    dbh.repo.updateStatus(a, "printing");
    dbh.repo.setSubstitution(a, 1, BLUE);

    await dispatcher.onFinished(a);

    expect(dbh.repo.getUnresolvedPendingActions()).toHaveLength(0);
    expect(dbh.repo.getJob(a)!.status).toBe("success");
  });
});
