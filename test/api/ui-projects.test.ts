import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createUiApp, projectRemainingSec } from "../../src/api/ui-routes.ts";
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

const form = (path: string, body: string) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

describe("projects page", () => {
  test("GET /projects lists projects with policy and plate progress", async () => {
    const fleet = repo.createProject("Benchy Fleet", "strict");
    const grid = repo.createProject("Gridfinity", "propagate");
    const a = repo.createJob({ filename: "a.3mf", project_id: fleet, estimated_seconds: 600 });
    repo.updateStatus(a, "success");
    repo.createJob({ filename: "b.3mf", project_id: fleet, estimated_seconds: 600 }); // queued-ish (processing)
    repo.createJob({ filename: "c.3mf", project_id: grid });

    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Benchy Fleet");
    expect(html).toContain("Gridfinity");
    expect(html).toContain("完了 1/2"); // fleet: 1 of 2 done
    expect(html).toContain("厳密（色を固定）");
    expect(html).toContain("伝播（代替色を継承）");
    // the strict project's select has strict pre-selected
    expect(html).toContain('<option value="strict" selected>');
    expect(html).toContain('hx-post="/ui/projects/' + fleet + '/policy"');
  });

  test("empty state when there are no projects", async () => {
    const res = await app.request("/projects");
    expect(await res.text()).toContain("プロジェクトがありません");
  });

  test("POST /ui/projects creates a project and returns the refreshed fragment", async () => {
    const res = await form("/ui/projects", "name=NightRun&policy=propagate");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="projects"');
    expect(html).toContain("NightRun");
    const created = repo.listProjects().find((p) => p.name === "NightRun");
    expect(created?.color_consistency_policy).toBe("propagate");
  });

  test("POST /ui/projects ignores a blank name", async () => {
    await form("/ui/projects", "name=%20%20&policy=strict");
    expect(repo.listProjects()).toHaveLength(0);
  });

  test("POST /ui/projects/:id/policy toggles the policy", async () => {
    const id = repo.createProject("P", "strict");
    const res = await form(`/ui/projects/${id}/policy`, "policy=propagate");
    expect(res.status).toBe(200);
    expect(repo.getProject(id)?.color_consistency_policy).toBe("propagate");
  });

  test("POST /ui/projects/:id/policy rejects an invalid policy", async () => {
    const id = repo.createProject("P", "strict");
    await form(`/ui/projects/${id}/policy`, "policy=bogus");
    expect(repo.getProject(id)?.color_consistency_policy).toBe("strict"); // unchanged
  });

  describe("per-project ETA aggregation", () => {
    test("projectRemainingSec sums estimates + a swap per plate boundary", () => {
      expect(projectRemainingSec([])).toBe(0);
      expect(projectRemainingSec([{ estimated_seconds: 600 }])).toBe(600); // no boundary
      // 600 + 900 + 1 boundary * 60
      expect(projectRemainingSec([{ estimated_seconds: 600 }, { estimated_seconds: 900 }])).toBe(1560);
      // nulls count as 0 duration but still add a boundary
      expect(projectRemainingSec([{ estimated_seconds: null }, { estimated_seconds: null }])).toBe(60);
    });

    test("a project card carries the ETA data + running-plate hints", async () => {
      const p = repo.createProject("Fleet");
      const run = repo.createJob({ filename: "a.3mf", project_id: p, estimated_seconds: 4500 });
      repo.updateStatus(run, "printing");
      const q = repo.createJob({ filename: "b.3mf", project_id: p, estimated_seconds: 3900 });
      repo.updateStatus(q, "queued");

      const html = await (await app.request("/projects")).text();
      expect(html).toContain('data-eta-sec="8460"'); // 4500+3900+60
      expect(html).toContain(`data-run-id="${run}"`);
      expect(html).toContain('data-run-est="4500"');
      expect(html).toContain("完了予定");
      // the page ships the ETA client script, which polls the live status
      expect(html).toContain('src="/vendor/projects.js"');
      const js = await (await app.request("/vendor/projects.js")).text();
      expect(js).toContain("/api/printer/status");
      expect(js).toContain("完了予定");
    });
  });

  test("both pages expose the nav", async () => {
    const dash = await (await app.request("/")).text();
    const proj = await (await app.request("/projects")).text();
    for (const html of [dash, proj]) {
      expect(html).toContain('href="/projects"');
      expect(html).toContain('href="/"');
    }
    expect(proj).toContain('class="navlink active"'); // projects link active on /projects
  });
});
