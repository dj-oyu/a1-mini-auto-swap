import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUiApp } from "../../src/api/ui-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";

let dbh: Db;
let repo: Repo;
let app: Hono;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  app = createUiApp(repo);
});

async function body(path = "/"): Promise<{ status: number; type: string | null; text: string }> {
  const res = await app.request(path);
  return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
}

describe("GET / (dashboard SSR)", () => {
  test("serves an HTML document", async () => {
    const r = await body();
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain("<!doctype html>");
  });

  test("shows the empty state when the queue is empty", async () => {
    const r = await body();
    expect(r.text).toContain("キューは空です");
  });

  test("renders each job's filename and a status badge", async () => {
    const printing = repo.createJob({ filename: "hull.gcode.3mf", estimated_seconds: 4500 });
    repo.updateStatus(printing, "printing");
    const failed = repo.createJob({ filename: "clip.gcode.3mf" });
    repo.updateStatus(failed, "failed", "boom");

    const r = await body();
    expect(r.text).toContain("hull.gcode.3mf");
    expect(r.text).toContain("clip.gcode.3mf");
    expect(r.text).toContain("印刷中"); // printing label
    expect(r.text).toContain("失敗"); // failed label
    expect(r.text).toContain("1時間15分"); // 4500s ETA formatting
  });

  test("shows the stocker remaining/capacity in the header", async () => {
    repo.setStocker(8, 5);
    const r = await body();
    expect(r.text).toContain("5/8");
  });

  test("attempts and color-substitution markers are surfaced", async () => {
    const id = repo.createJob({ filename: "x.3mf" });
    repo.updateStatus(id, "success");
    repo.incrementAttempts(id);
    repo.setSubstitution(id, 1, "#17becf");
    const r = await body();
    expect(r.text).toContain("試行 1");
    expect(r.text).toContain("色代替");
  });

  describe("対応待ち banner", () => {
    test("is calm (0) when there are no pending actions", async () => {
      const r = await body();
      expect(r.text).toContain("対応待ち 0");
      expect(r.text).toContain("banner calm");
    });

    test("counts unresolved actions and goes red for a blocking_queue", async () => {
      const job = repo.createJob({ filename: "j.3mf" });
      repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue", message: "空" });
      repo.createPendingAction({ type: "filament_confirm", severity: "advisory", job_id: job });
      const r = await body();
      expect(r.text).toContain("対応待ち 2");
      expect(r.text).toContain("banner red");
      expect(r.text).toContain("ストッカー補充");
    });

    test("is amber (not red) when the worst severity is blocking_job", async () => {
      const job = repo.createJob({ filename: "j.3mf" });
      repo.createPendingAction({ type: "retry_decision", severity: "blocking_job", job_id: job });
      const r = await body();
      expect(r.text).toContain("banner amber");
      expect(r.text).not.toContain("banner red");
    });
  });

  describe("security: untrusted content from uploads", () => {
    test("escapes a malicious filename instead of injecting markup", async () => {
      repo.createJob({ filename: "<script>alert(1)</script>.3mf" });
      const r = await body();
      expect(r.text).not.toContain("<script>alert(1)</script>");
      expect(r.text).toContain("&lt;script&gt;");
    });

    test("drops a non-hex filament color rather than inlining it into a style", async () => {
      repo.createJob({
        filename: "evil.3mf",
        filaments: [{ slot: 1, color: "red;} body{display:none}" }],
      });
      const r = await body();
      expect(r.text).not.toContain("body{display:none}");
    });

    test("inlines a valid hex filament color as a swatch background", async () => {
      repo.createJob({ filename: "ok.3mf", filaments: [{ slot: 1, color: "#1f77b4" }] });
      const r = await body();
      expect(r.text).toContain("#1f77b4");
    });
  });
});
