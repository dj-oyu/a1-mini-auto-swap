import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import {
  createPrinterApp,
  type LiveStatus,
  type PrinterStatusSource,
  type PrinterStatusView,
} from "../../src/api/printer-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";

/** Controllable status source standing in for the MQTT client. */
function source(latest: LiveStatus | null): PrinterStatusSource {
  return { latest: () => latest };
}

let dbh: Db;
let repo: Repo;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
});

const get = async (app: Hono): Promise<PrinterStatusView> =>
  (await (await app.request("/api/printer/status")).json()) as PrinterStatusView;

describe("GET /api/printer/status (spec ch8/10)", () => {
  test("reports the live percent + remaining for the printing job", async () => {
    const id = repo.createJob({ filename: "p.3mf", estimated_seconds: 3600 });
    repo.updateStatus(id, "printing");
    const app = createPrinterApp({
      repo,
      status: source({ gcodeState: "RUNNING", mcPercent: 42, mcRemainingTime: 73 }),
    });

    const view = await get(app);
    expect(view.printing).toBe(true);
    expect(view.job_id).toBe(id);
    expect(view.percent).toBe(42);
    expect(view.remaining_min).toBe(73);
    expect(view.gcode_state).toBe("RUNNING");
  });

  test("printing:false when nothing is printing (even with a status)", async () => {
    repo.createJob({ filename: "p.3mf" }); // stays processing
    const app = createPrinterApp({
      repo,
      status: source({ gcodeState: "IDLE", mcPercent: 0, mcRemainingTime: 0 }),
    });
    const view = await get(app);
    expect(view.printing).toBe(false);
    expect(view.job_id).toBeNull();
  });

  test("printing:false when there is no live status yet", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    repo.updateStatus(id, "printing");
    const app = createPrinterApp({ repo, status: source(null) });
    const view = await get(app);
    expect(view.printing).toBe(false);
  });

  test("coerces non-finite live numbers to 0", async () => {
    const id = repo.createJob({ filename: "p.3mf" });
    repo.updateStatus(id, "printing");
    const app = createPrinterApp({
      repo,
      status: source({ gcodeState: "RUNNING", mcPercent: NaN, mcRemainingTime: NaN }),
    });
    const view = await get(app);
    expect(view.percent).toBe(0);
    expect(view.remaining_min).toBe(0);
  });
});
