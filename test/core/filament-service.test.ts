import { beforeEach, describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../src/db/index.ts";
import { FilamentService } from "../../src/core/filament-service.ts";
import type { AmsProvider, Notifier, NotifyEvent, PrinterPort } from "../../src/core/ports.ts";
import type { AmsTray } from "../../src/core/runout.ts";
import type { JobRow } from "../../src/db/types.ts";

const RED = "#FF0000";
const BLUE = "#0000FF";

class FakePrinter implements PrinterPort {
  resumed: Array<{ jobId: number; slot: number }> = [];
  async startPrint(_j: JobRow): Promise<void> {}
  async ejectAndReset(): Promise<void> {}
  async resumeWithAlternateSlot(jobId: number, slot: number): Promise<void> {
    this.resumed.push({ jobId, slot });
  }
}
class FakeAms implements AmsProvider {
  constructor(private trays: AmsTray[]) {}
  getTrays(): AmsTray[] {
    return this.trays;
  }
}
class RecNotifier implements Notifier {
  events: NotifyEvent[] = [];
  notify(e: NotifyEvent): void {
    this.events.push(e);
  }
}

let dbh: Db;
let printer: FakePrinter;
let notifier: RecNotifier;

beforeEach(() => {
  dbh = openDb(":memory:");
  printer = new FakePrinter();
  notifier = new RecNotifier();
});

function job(policyOverride?: string): number {
  const id = dbh.repo.createJob({ filename: "j" });
  dbh.repo.updateStatus(id, "printing");
  if (policyOverride) {
    dbh.db.query("UPDATE jobs SET filament_runout_policy_override=? WHERE id=?").run(policyOverride, id);
  }
  return id;
}

function svc(trays: AmsTray[]) {
  return new FilamentService(dbh.repo, new FakeAms(trays), printer, { minThresholdG: 10, notifier });
}

describe("FilamentService.onRunout (spec 14)", () => {
  test("manual policy => filament_runout pending, no resume (INV-RUNOUT-01)", async () => {
    dbh.repo.setSetting("filament_runout_policy", "manual");
    const id = job();
    await svc([
      { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
      { slot: 1, color: RED, type: "PLA", remaining_g: 800 },
    ]).onRunout(id, 0);

    expect(dbh.repo.getUnresolvedPendingActions().some((p) => p.type === "filament_runout")).toBe(true);
    expect(printer.resumed).toHaveLength(0);
  });

  test("allow_material_match => resume on alt slot, records substitution + advisory (INV-RUNOUT-04/06)", async () => {
    dbh.repo.setSetting("filament_runout_policy", "allow_material_match");
    const id = job();
    await svc([
      { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
      { slot: 1, color: BLUE, type: "PLA", remaining_g: 800 },
    ]).onRunout(id, 0);

    expect(printer.resumed).toEqual([{ jobId: id, slot: 1 }]);
    expect(dbh.repo.getJob(id)!.substituted_slot).toBe(1);
    expect(dbh.repo.getJob(id)!.substituted_color).toBe(BLUE);
    expect(notifier.events.some((e) => e.type === "filament_switched")).toBe(true);
    expect(dbh.repo.getUnresolvedPendingActions()).toHaveLength(0);
  });

  test("same_color_only with a same-color alt => resume, no substitution recorded", async () => {
    dbh.repo.setSetting("filament_runout_policy", "same_color_only");
    const id = job();
    await svc([
      { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
      { slot: 2, color: RED, type: "PLA", remaining_g: 500 },
    ]).onRunout(id, 0);

    expect(printer.resumed).toEqual([{ jobId: id, slot: 2 }]);
    expect(dbh.repo.getJob(id)!.substituted_color).toBeNull();
  });

  test("no viable candidate => pending, no resume (INV-RUNOUT-05)", async () => {
    dbh.repo.setSetting("filament_runout_policy", "allow_material_match");
    const id = job();
    await svc([
      { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
      { slot: 1, color: RED, type: "PETG", remaining_g: 800 }, // wrong material
    ]).onRunout(id, 0);

    expect(dbh.repo.getUnresolvedPendingActions().some((p) => p.type === "filament_runout")).toBe(true);
    expect(printer.resumed).toHaveLength(0);
  });

  test("per-job policy override beats the system default", async () => {
    dbh.repo.setSetting("filament_runout_policy", "manual"); // system says manual...
    const id = job("allow_material_match"); // ...but the job overrides
    await svc([
      { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
      { slot: 1, color: BLUE, type: "PLA", remaining_g: 800 },
    ]).onRunout(id, 0);

    expect(printer.resumed).toEqual([{ jobId: id, slot: 1 }]); // override took effect
  });
});
