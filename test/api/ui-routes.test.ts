import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { strToU8, zipSync } from "fflate";
import { createUiApp } from "../../src/api/ui-routes.ts";
import { openDb, type Db } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import { cacheFileName } from "../../src/core/artifact.ts";

let dbh: Db;
let repo: Repo;
let app: Hono;
let cacheDir: string;

beforeEach(() => {
  dbh = openDb(":memory:");
  repo = dbh.repo;
  cacheDir = mkdtempSync(join(tmpdir(), "ui-routes-"));
  app = createUiApp({ repo, cacheDir });
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

const PLATE_GCODE = ["; HEADER_BLOCK_START", "; name = plate_1", "; HEADER_BLOCK_END", "G28", ""].join("\n");

/** Write a cached .gcode.3mf carrying the given plate gcode entries (+ optional
 *  per-plate static estimates via Metadata/plate_N.json) so the confirm
 *  modal's readCachedPlates() picks it up. */
function writeCachedThreemf(id: number, plateNums: number[], estimates: Record<number, number> = {}): void {
  const files: Record<string, Uint8Array> = {
    "Metadata/project_settings.config": strToU8("{}"),
  };
  for (const n of plateNums) {
    files[`Metadata/plate_${n}.gcode`] = strToU8(PLATE_GCODE);
    if (estimates[n] != null) {
      files[`Metadata/plate_${n}.json`] = strToU8(JSON.stringify({ prediction: estimates[n] }));
    }
  }
  writeFileSync(join(cacheDir, cacheFileName(id)), Buffer.from(zipSync(files)));
}

async function body(path = "/"): Promise<{ status: number; type: string | null; text: string }> {
  const res = await app.request(path);
  return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
}

/** Fetch a served asset's text (client JS/CSS now live in public/vendor/). */
async function asset(path: string): Promise<string> {
  return await (await app.request(path)).text();
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

  describe("htmx wiring (MVP #2)", () => {
    test("loads vendored htmx (not a CDN) and wraps the reactive area", async () => {
      const r = await body();
      expect(r.text).toContain('src="/vendor/htmx.min.js"');
      expect(r.text).not.toContain("//unpkg");
      expect(r.text).not.toContain("cdn");
      expect(r.text).toContain('id="dashboard"');
    });

    test("serves the vendored htmx asset", async () => {
      const res = await app.request("/vendor/htmx.min.js");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("htmx");
    });

    test("each pending row carries a resolve button targeting #dashboard", async () => {
      const job = repo.createJob({ filename: "j.3mf" });
      repo.createPendingAction({ type: "retry_decision", severity: "blocking_job", job_id: job });
      const r = await body();
      expect(r.text).toContain('hx-post="/ui/pending-actions/');
      expect(r.text).toContain('hx-target="#dashboard"');
      expect(r.text).toContain('hx-swap="outerHTML"');
    });

    test("a stocker_refill row offers a refill (not a plain resolve)", async () => {
      repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue", message: "空" });
      const r = await body();
      expect(r.text).toContain('hx-post="/ui/stocker/refill"');
      expect(r.text).toContain("補充完了");
    });
  });

  describe("card actions (retry / delete)", () => {
    test("a failed card offers リトライ and 削除; the client wires both", async () => {
      const id = repo.createJob({ filename: "boom.3mf" });
      repo.updateStatus(id, "failed", "plate slipped");
      const r = await body();
      expect(r.text).toContain(`data-retry="${id}"`);
      expect(r.text).toContain(`data-delete="${id}"`);
      const js = await asset("/vendor/app.js");
      expect(js).toContain("/retry");
      expect(js).toContain("method: 'DELETE'");
    });

    test("a queued card offers 削除 but not リトライ", async () => {
      const id = repo.createJob({ filename: "q.3mf" });
      repo.updateStatus(id, "queued");
      const r = await body();
      expect(r.text).toContain(`data-delete="${id}"`);
      expect(r.text).not.toContain(`data-retry="${id}"`);
    });

    test("a printing card offers 中止 but not delete/retry", async () => {
      const id = repo.createJob({ filename: "live.3mf" });
      repo.updateStatus(id, "printing");
      const r = await body();
      expect(r.text).toContain(`data-abort="${id}"`);
      expect(r.text).toContain("中止");
      expect(r.text).not.toContain(`data-delete="${id}"`);
      expect(r.text).not.toContain(`data-retry="${id}"`);
      expect(await asset("/vendor/app.js")).toContain("/abort"); // client wires the abort fetch
    });

    test("a non-printing card offers no 中止", async () => {
      const id = repo.createJob({ filename: "q.3mf" });
      repo.updateStatus(id, "queued");
      const r = await body();
      expect(r.text).not.toContain(`data-abort="${id}"`);
    });

    test("reorderable cards get ↑/↓; printing/terminal do not; client wires reorder", async () => {
      const q = repo.createJob({ filename: "q.3mf" });
      repo.updateStatus(q, "queued");
      const printing = repo.createJob({ filename: "p.3mf" });
      repo.updateStatus(printing, "printing");
      const done = repo.createJob({ filename: "d.3mf" });
      repo.updateStatus(done, "success");

      const r = await body();
      expect(r.text).toContain(`data-move-up="${q}"`);
      expect(r.text).toContain(`data-move-down="${q}"`);
      expect(r.text).not.toContain(`data-move-up="${printing}"`);
      expect(r.text).not.toContain(`data-move-up="${done}"`);
      expect(await asset("/vendor/app.js")).toContain("/api/queue/reorder");
    });

    test("reorderable cards get a drag handle; the client wires pointer sortable", async () => {
      const q = repo.createJob({ filename: "q.3mf" });
      repo.updateStatus(q, "queued");
      const done = repo.createJob({ filename: "d.3mf" });
      repo.updateStatus(done, "success");
      const r = await body();
      expect(r.text).toContain("data-drag-handle");
      // terminal card has no handle (only one handle → for the queued job)
      expect((r.text.match(/data-drag-handle/g) || []).length).toBe(1);
      const js = await asset("/vendor/app.js");
      expect(js).toContain("pointerdown");
      expect(js).toContain("data-drag-handle");
    });
  });

  describe("thumbnails (MVP #6)", () => {
    test("queue cards reference the job's thumbnail endpoint and hide it if absent", async () => {
      const id = repo.createJob({ filename: "p.3mf" });
      const r = await body();
      expect(r.text).toContain(`src="/api/queue/${id}/thumbnail"`);
      // graceful when no thumb — delegated to app.js (no inline handler, CSP-friendly)
      expect(r.text).toContain('data-onerror="remove"');
    });

    test("the confirm modal embeds the 3D viewer with a thumbnail fallback", async () => {
      const id = repo.createJob({ filename: "p.3mf", filaments: [{ slot: 1, color: "#112233" }] });
      const res = await app.request(`/ui/queue/${id}/confirm`);
      const text = await res.text();
      expect(text).toContain('class="viewer"');
      expect(text).toContain(`data-model-url="/api/queue/${id}/model"`);
      expect(text).toContain('data-color="#112233"'); // seeded from first filament
      expect(text).toContain(`src="/api/queue/${id}/thumbnail"`); // fallback img
    });
  });

  describe("3D viewer (MVP #6)", () => {
    test("the page loads vendored three via an import map (no CDN)", async () => {
      const r = await body();
      expect(r.text).toContain('type="importmap"');
      expect(r.text).toContain('"three":"/vendor/three.module.min.js"');
      expect(r.text).toContain('src="/vendor/viewer.js"');
      expect(r.text).not.toContain("unpkg");
      expect(r.text).not.toContain("cdn");
    });

    test("serves the vendored three module + viewer script", async () => {
      const three = await app.request("/vendor/three.module.min.js");
      expect(three.status).toBe(200);
      const viewer = await app.request("/vendor/viewer.js");
      expect(viewer.status).toBe(200);
      expect(await viewer.text()).toContain("initViewers");
    });

    test("clicking a card thumbnail opens the 3D preview modal", async () => {
      const id = repo.createJob({ filename: "p.3mf" });
      const r = await body();
      expect(r.text).toContain(`hx-get="/ui/queue/${id}/preview"`);
    });

    test("GET .../preview renders a viewer modal", async () => {
      const id = repo.createJob({ filename: "p.3mf" });
      const res = await app.request(`/ui/queue/${id}/preview`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("3D プレビュー");
      expect(text).toContain(`data-model-url="/api/queue/${id}/model"`);
      expect(text).toContain("modal-overlay");
    });

    test("preview of a missing job is friendly, not a crash", async () => {
      const res = await app.request("/ui/queue/999999/preview");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("見つかりません");
    });
  });

  describe("upload control (MVP #5)", () => {
    test("the header offers a 3MF file picker / drop zone", async () => {
      const r = await body();
      expect(r.text).toContain('id="dropzone"');
      expect(r.text).toContain('id="fileInput"');
      expect(r.text).toContain('accept=".gcode.3mf,.3mf"');
    });

    test("the client uploads to POST /api/queue then opens the confirm modal", async () => {
      const js = await asset("/vendor/app.js");
      expect(js).toContain("/api/queue?filename=");
      expect(js).toContain("openConfirm");
      expect(js).toContain("uploadFile");
    });
  });

  describe("filament-confirm modal (MVP #5)", () => {
    test("processing cards offer a フィラメント確認 button loading the modal", async () => {
      repo.createJob({ filename: "new.3mf" }); // stays 'processing'
      const r = await body();
      expect(r.text).toContain("フィラメント確認");
      expect(r.text).toContain('hx-get="/ui/queue/1/confirm"');
      expect(r.text).toContain('hx-target="#modal"');
    });

    test("non-processing cards do not offer the confirm button", async () => {
      const id = repo.createJob({ filename: "done.3mf" });
      repo.updateStatus(id, "queued");
      const r = await body();
      // only the queued job exists → no confirm-button markup on any card.
      // (cards still carry a /preview hx-get, and the upload script mentions
      // "/confirm", so assert on the confirm endpoint's exact attribute form)
      expect(r.text).not.toContain('/confirm"');
    });

    test("GET .../confirm renders a swatch + AMS dropdown per filament slot", async () => {
      const id = repo.createJob({
        filename: "two.3mf",
        filaments: [
          { slot: 1, color: "#1f77b4" },
          { slot: 2, color: "#ff7f0e" },
        ],
        ams_mapping: [2, -1, -1, -1],
      });
      const res = await app.request(`/ui/queue/${id}/confirm`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('data-confirm="' + id + '"');
      expect(text).toContain("#1f77b4");
      expect(text).toContain("#ff7f0e");
      expect(text).toContain('data-slot="1"');
      expect(text).toContain('data-slot="2"');
      expect(text).toContain("未使用");
      expect(text).toContain("AMS 4");
      // slot 1's stored mapping (tray index 2 → "AMS 3") is pre-selected
      expect(text).toMatch(/<option value="2" selected>AMS 3<\/option>/);
      // each row carries its filament color for the live 3D-recolor hook
      // (spec 17 §9: スロット変更UIから即時再着色 — app.js → viewer.__setColor)
      expect(text).toContain('data-color="#1f77b4"');
      expect(text).toContain('data-color="#ff7f0e"');
      const js = await asset("/vendor/app.js");
      expect(js).toContain("__setColor");
    });

    test("handles the uploader's index-based filament shape (not just slot)", async () => {
      // POST /api/queue stores extractFilaments()'s shape: {index,color,type}
      const id = repo.createJob({
        filename: "uploaded.3mf",
        filaments: [
          { index: 0, color: "#ff0000", type: "PLA" },
          { index: 1, color: "#0000ff", type: "PETG" },
        ],
      });
      const res = await app.request(`/ui/queue/${id}/confirm`);
      const text = await res.text();
      // index 0/1 must normalize to slot 1/2 (not "undefined")
      expect(text).toContain('data-slot="1"');
      expect(text).toContain('data-slot="2"');
      expect(text).not.toContain("undefined");
      expect(text).toContain("#ff0000");
    });

    test("the confirm panel offers a project assignment select", async () => {
      const fleet = repo.createProject("Benchy Fleet");
      repo.createProject("Gridfinity");
      const id = repo.createJob({ filename: "p.3mf", project_id: fleet });
      const text = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(text).toContain("data-project");
      expect(text).toContain("（プロジェクトなし）");
      expect(text).toContain("Benchy Fleet");
      expect(text).toContain("Gridfinity");
      // the job's current project is pre-selected
      expect(text).toMatch(new RegExp(`<option value="${fleet}" selected>Benchy Fleet</option>`));
    });

    test("confirming a non-processing job is refused in the panel", async () => {
      const id = repo.createJob({ filename: "x.3mf" });
      repo.updateStatus(id, "printing");
      const res = await app.request(`/ui/queue/${id}/confirm`);
      const text = await res.text();
      expect(text).toContain("確認待ちではありません");
      expect(text).not.toContain("data-confirm=");
    });

    test("a missing job yields a friendly panel, not a crash", async () => {
      const res = await app.request("/ui/queue/999999/confirm");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("見つかりません");
    });

    test("the page has a #modal mount and the confirm-submit client logic", async () => {
      expect((await body()).text).toContain('id="modal"'); // HTML mount
      const js = await asset("/vendor/app.js");
      expect(js).toContain("/filaments");
      expect(js).toContain("ams_mapping");
    });
  });

  describe("plate selection (multi-plate 3mf upload)", () => {
    test("a multi-plate archive shows a plate picker with a radio per plate", async () => {
      const id = repo.createJob({ filename: "multi.3mf", filaments: [{ slot: 1, color: "#112233" }] });
      writeCachedThreemf(id, [1, 24], { 1: 3600, 24: 1800 });

      const res = await app.request(`/ui/queue/${id}/confirm`);
      const text = await res.text();
      expect(text).toContain("印刷対象プレート");
      expect(text).toContain('data-plate="plate_1"');
      expect(text).toContain('data-plate="plate_24"');
      // static per-plate estimate, when the archive carries a plate_N.json
      expect(text).toContain("1時間"); // plate_1: 3600s
      expect(text).toContain("30分"); // plate_24: 1800s
      // no thumbnail dependency: no per-plate thumbnail endpoint call
      expect(text).not.toContain("thumbnail?plate=");
      // first plate defaults checked when nothing has been selected yet
      expect(text).toMatch(/data-plate="plate_1"[^>]*checked/);
    });

    test("a previously-selected plate stays checked", async () => {
      const id = repo.createJob({ filename: "multi.3mf" });
      writeCachedThreemf(id, [1, 24]);
      repo.setSelectedPlate(id, "plate_24");

      const text = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(text).toMatch(/data-plate="plate_24"[^>]*checked/);
      expect(text).not.toMatch(/data-plate="plate_1"[^>]*checked/);
    });

    test("a single-plate archive shows no plate picker (unchanged behaviour)", async () => {
      const id = repo.createJob({ filename: "single.3mf" });
      writeCachedThreemf(id, [1]);

      const text = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(text).not.toContain("印刷対象プレート");
      expect(text).not.toContain('name="plate"');
    });

    test("no cached artifact at all also shows no plate picker", async () => {
      const id = repo.createJob({ filename: "nocache.3mf" }); // nothing written to cacheDir
      const text = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(text).not.toContain("印刷対象プレート");
    });

    test("the client submits the checked plate as selected_plate", async () => {
      const js = await asset("/vendor/app.js");
      expect(js).toContain("selected_plate");
      expect(js).toContain('input[name="plate"]:checked');
    });
  });

  describe("printing header (MVP #4)", () => {
    test("renders no header when nothing is printing", async () => {
      repo.createJob({ filename: "waiting.3mf" }); // stays 'processing'
      const r = await body();
      // the <section> is absent (the string also appears in the client script,
      // so assert on the rendered element, not the bare attribute)
      expect(r.text).not.toContain('<section class="printing"');
    });

    test("shows the active plate with start epoch + estimate for the client clock", async () => {
      const id = repo.createJob({ filename: "live.gcode.3mf", estimated_seconds: 3600 });
      repo.updateStatus(id, "printing");
      const job = repo.getJob(id)!;
      const expectedStart = Date.parse(job.updated_at.replace(" ", "T") + "Z");

      const r = await body();
      expect(r.text).toContain('<section class="printing"');
      expect(r.text).toContain("live.gcode.3mf");
      expect(r.text).toContain(`data-start="${expectedStart}"`);
      expect(r.text).toContain('data-est="3600"');
      expect(r.text).toContain('class="prog-bar"');
    });

    test("the header lives inside the reactive fragment (refreshes via SSE)", async () => {
      const id = repo.createJob({ filename: "live.3mf", estimated_seconds: 1200 });
      repo.updateStatus(id, "printing");
      const res = await app.request("/ui/dashboard");
      const text = await res.text();
      expect(text).toContain('<section class="printing"');
      expect(text).toContain("live.3mf");
    });

    test("the client script computes % and finish-time", async () => {
      const js = await asset("/vendor/app.js");
      expect(js).toContain("updatePrinting");
      // clock formatting moved to the shared helper module (PF.fmtClock)
      expect(js).toContain("fmtClock");
      const shared = await asset("/vendor/shared.js");
      expect(shared).toContain("toLocaleTimeString");
    });

    test("the header carries the job id and the client polls the live status", async () => {
      const id = repo.createJob({ filename: "live.3mf", estimated_seconds: 1200 });
      repo.updateStatus(id, "printing");
      expect((await body()).text).toContain(`data-job-id="${id}"`); // HTML
      // client prefers measured ETA from /api/printer/status (remaining_min)
      const js = await asset("/vendor/app.js");
      expect(js).toContain("/api/printer/status");
      expect(js).toContain("remaining_min");
      expect(js).toContain("実測");
    });

    test("the client consumes push-based SSE progress (no 10s polling loop)", async () => {
      const js = await asset("/vendor/app.js");
      expect(js).toContain("es.addEventListener('progress'");
      // the old fixed 10s poll interval is gone (SSE-driven now)
      expect(js).not.toContain("setInterval(pollStatus, 10000)");
    });

    test("build-plate low: a toast mount + a stocker_low SSE handler", async () => {
      expect((await body()).text).toContain('id="toast"'); // HTML mount
      const js = await asset("/vendor/app.js");
      expect(js).toContain("es.addEventListener('stocker_low'");
      expect(js).toContain("showToast");
    });
  });

  describe("camera snapshot (spec 17 §5)", () => {
    test("the statusline has a camera button opening the snapshot modal", async () => {
      const r = await body();
      expect(r.text).toContain("カメラ");
      expect(r.text).toContain('hx-get="/ui/snapshot"');
      expect(r.text).toContain('hx-target="#modal"');
    });

    test("GET /ui/snapshot renders the camera modal wired to the live MJPEG relay", async () => {
      const res = await app.request("/ui/snapshot");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('class="snapshot"');
      // live relay stream, not a one-shot snapshot; no manual 更新 button
      expect(text).toContain('src="/api/printer/camera.mjpeg"');
      expect(text).toContain("ライブ");
      expect(text).not.toContain("data-snap-refresh");
      expect(text).toContain("カメラ映像がありません"); // graceful empty
    });

    test("closeModal blanks the .snapshot src to drop the MJPEG connection", async () => {
      const js = await asset("/vendor/app.js");
      // removing the <img> alone can leave the stream open in some browsers, so
      // the client must explicitly clear the src on close.
      expect(js).toContain(".snapshot");
      expect(js).toMatch(/cam\.src\s*=\s*''/);
    });
  });

  describe("live updates (MVP #3)", () => {
    test("the page subscribes to the SSE stream", async () => {
      expect((await body()).text).toContain('src="/vendor/app.js"');
      const js = await asset("/vendor/app.js");
      expect(js).toContain("new EventSource('/events')");
      expect(js).toContain("/ui/dashboard");
    });

    test("a hidden connChip is wired to the EventSource's error/open lifecycle", async () => {
      const html = (await body()).text;
      expect(html).toContain('id="connChip"');
      // calm styling only — red is reserved for "stop" (spec 17)
      expect(html).not.toContain('id="connChip" class="conn-chip red"');
      const js = await asset("/vendor/app.js");
      expect(js).toContain("PF.watchConnection(es, document.getElementById('connChip'))");
      const shared = await asset("/vendor/shared.js");
      expect(shared).toContain("PF.watchConnection");
      expect(shared).toContain("addEventListener('error'");
      expect(shared).toContain("addEventListener('open'");
    });

    test("GET /ui/dashboard returns just the reactive fragment", async () => {
      repo.setStocker(8, 5);
      const res = await app.request("/ui/dashboard");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('id="dashboard"');
      expect(text).not.toContain("<!doctype html>");
      expect(text).toContain("5/8");
    });
  });

  describe("POST /ui/pending-actions/:id/resolve", () => {
    test("resolves the action and returns the refreshed #dashboard fragment", async () => {
      const job = repo.createJob({ filename: "j.3mf" });
      const pid = repo.createPendingAction({
        type: "retry_decision",
        severity: "blocking_job",
        job_id: job,
      });
      expect(repo.getUnresolvedPendingActions()).toHaveLength(1);

      const res = await app.request(`/ui/pending-actions/${pid}/resolve`, { method: "POST" });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('id="dashboard"');
      expect(text).not.toContain("<!doctype html>"); // fragment, not a full page
      expect(text).toContain("対応待ち 0");
      expect(repo.getUnresolvedPendingActions()).toHaveLength(0);
    });
  });

  describe("POST /ui/stocker/refill", () => {
    test("refills to capacity and clears the stocker_refill pending", async () => {
      repo.setStocker(8, 0);
      repo.createPendingAction({ type: "stocker_refill", severity: "blocking_queue", message: "空" });

      const res = await app.request("/ui/stocker/refill", { method: "POST" });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('id="dashboard"');
      expect(text).toContain("8/8");
      expect(text).toContain("対応待ち 0");
      expect(repo.getStocker()!.remaining).toBe(8);
      expect(repo.getUnresolvedPendingActions()).toHaveLength(0);
    });
  });

  describe("modal accessibility (frontend polish)", () => {
    test("every modal-box is an ARIA dialog", async () => {
      // snapshot modal
      const snap = await (await app.request("/ui/snapshot")).text();
      expect(snap).toContain('role="dialog"');
      expect(snap).toContain('aria-modal="true"');

      // preview modal (found + not-found variants)
      const id = repo.createJob({ filename: "p.3mf" });
      const preview = await (await app.request(`/ui/queue/${id}/preview`)).text();
      expect(preview).toContain('role="dialog"');
      expect(preview).toContain('aria-modal="true"');
      const previewMissing = await (await app.request("/ui/queue/999999/preview")).text();
      expect(previewMissing).toContain('role="dialog"');

      // confirm modal (found + not-processing variants)
      const confirm = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(confirm).toContain('role="dialog"');
      expect(confirm).toContain('aria-modal="true"');
      repo.updateStatus(id, "printing");
      const confirmWrongStatus = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(confirmWrongStatus).toContain('role="dialog"');
    });

    test("no inline onerror handlers remain (CSP-friendly delegation instead)", async () => {
      // matches a bare `onerror="` but not `data-onerror="` (negative lookbehind on the hyphen)
      const inlineOnerror = /(?<!-)onerror="/;
      repo.createJob({ filename: "p.3mf" }); // so the card-thumb's data-onerror is present
      const dashboard = (await body()).text;
      expect(dashboard).not.toMatch(inlineOnerror);
      const snap = await (await app.request("/ui/snapshot")).text();
      expect(snap).not.toMatch(inlineOnerror);
      const id = repo.createJob({ filename: "p.3mf" });
      const preview = await (await app.request(`/ui/queue/${id}/preview`)).text();
      expect(preview).not.toMatch(inlineOnerror);
      const confirm = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(confirm).not.toMatch(inlineOnerror);
      // the delegated attributes are present instead
      expect(dashboard).toContain('data-onerror="remove"');
      expect(snap).toContain('data-onerror="snapshot"');
    });

    test("data-confirm-job is not emitted (unused attribute, removed)", async () => {
      const id = repo.createJob({ filename: "p.3mf" });
      const confirm = await (await app.request(`/ui/queue/${id}/confirm`)).text();
      expect(confirm).not.toContain("data-confirm-job");
    });

    test("app.js wires Escape-to-close, a Tab focus trap, and delegated error handling", async () => {
      const js = await asset("/vendor/app.js");
      expect(js).toContain("Escape");
      expect(js).toContain("focusableIn");
      expect(js).toMatch(/addEventListener\('error'.*true\)/s); // capture-phase delegation
      expect(js).toContain("data-onerror");
      // focus moves into the modal on open and back out on close
      expect(js).toContain("onModalOpened");
      expect(js).toContain(".focus()");
    });

    test("app.js shares one reorder-persist function between ↑/↓ and drag-drop", async () => {
      const js = await asset("/vendor/app.js");
      const matches = js.match(/function persistOrder/g) || [];
      expect(matches.length).toBe(1); // defined once
      expect((js.match(/persistOrder\(/g) || []).length).toBeGreaterThanOrEqual(3); // def + 2 call sites
    });
  });
});
