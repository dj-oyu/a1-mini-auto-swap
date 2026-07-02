import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { createVerifyApp, type VerifyDeps } from "../../src/api/verify-routes.ts";
import { openDb } from "../../src/db/index.ts";
import type { Repo } from "../../src/db/repo.ts";
import type { DiagnosticsResult } from "../../src/orchestrator/diagnostics.ts";
import type { PrinterStatusView } from "../../src/api/printer-routes.ts";

// Route-level tests with injected fakes: the automated state transitions
// (Stage 1-4), the confirmed:true / busy guards on the dry-run, the eject call,
// and the zod-validated progress persistence (round-trip + corruption recovery).
// No real I/O — every dep is a fake, so nothing here touches a printer.

function allPassDiag(over: Partial<DiagnosticsResult> = {}): DiagnosticsResult {
  return {
    host: "printer-stub",
    mqtt_reachable: true,
    ftps_reachable: true,
    mqtt_auth_ok: true,
    report_received: true,
    ftps_auth_ok: true,
    prot_mode: "C",
    prot_detail: "PROT P → 522; PROT C → 200",
    sample_report: { gcode_state: "IDLE", mc_percent: 0 },
    errors: {},
    ...over,
  };
}

function status(over: Partial<PrinterStatusView> = {}): PrinterStatusView {
  return { printing: false, job_id: null, percent: 0, remaining_min: 0, gcode_state: "IDLE", ...over };
}

interface Spies {
  dryRuns: number;
  dryRunSwapArgs: boolean[];
  ejects: number;
}

function build(opts: { diag?: DiagnosticsResult; status?: PrinterStatusView; dryRunThrows?: boolean } = {}) {
  const { repo } = openDb(":memory:");
  const spies: Spies = { dryRuns: 0, dryRunSwapArgs: [], ejects: 0 };
  const deps: VerifyDeps = {
    repo,
    runDiagnostics: async () => opts.diag ?? allPassDiag(),
    printerStatus: () => opts.status ?? status(),
    startDryRun: async (includeSwap: boolean) => {
      spies.dryRuns++;
      spies.dryRunSwapArgs.push(includeSwap);
      if (opts.dryRunThrows) throw new Error("unsafe gcode guard tripped");
    },
    eject: async () => {
      spies.ejects++;
    },
  };
  return { app: createVerifyApp(deps), repo, spies };
}

async function text(app: Hono, path: string, init?: RequestInit): Promise<string> {
  return await (await app.request(path, init)).text();
}

/** The persisted verify_progress, parsed (or null when unset). */
function progress(repo: Repo): {
  stages: Record<string, { status: string; note: string }>;
  diagnostics: unknown;
  printer: unknown;
} | null {
  const raw = repo.getSetting("verify_progress");
  return raw ? JSON.parse(raw) : null;
}

const form = (body: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body,
});
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("GET /verify (full page)", () => {
  test("serves an HTML document listing all 7 stages + the nav link", async () => {
    const { app } = build();
    const res = await app.request("/verify");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const t = await res.text();
    expect(t).toContain("<!doctype html>");
    for (let n = 1; n <= 7; n++) expect(t).toContain(`Stage ${n}`);
    expect(t).toContain("TCP到達性");
    expect(t).toContain("ドライリハーサル印刷");
    expect(t).toContain('href="/verify"'); // nav entry
    expect(t).toContain('src="/vendor/verify.js"');
  });

  test("initial state: every stage badge is 未実施 (no 合格 badge yet)", async () => {
    const { app } = build();
    const t = await text(app, "/verify");
    expect(t).toContain("badge slate"); // pending badge cls
    expect(t).not.toContain("badge green");
  });
});

describe("GET /ui/verify (fragment)", () => {
  test("returns just the #verify fragment, not a full document", async () => {
    const { app } = build();
    const t = await text(app, "/ui/verify");
    expect(t).toContain('id="verify"');
    expect(t).not.toContain("<!doctype html>");
  });
});

describe("POST /ui/verify/run-diagnostics (Stage 1-3 auto-judge)", () => {
  test("all-pass diagnostics mark stages 1-3 合格 and show evidence", async () => {
    const { app, repo } = build();
    const t = await text(app, "/ui/verify/run-diagnostics", { method: "POST" });
    const p = progress(repo)!;
    expect(p.stages["1"]!.status).toBe("passed");
    expect(p.stages["2"]!.status).toBe("passed");
    expect(p.stages["3"]!.status).toBe("passed");
    // evidence rendered
    expect(t).toContain("badge green");
    expect(t).toContain("PROT モード");
    expect(t).toContain("PROT P → 522; PROT C → 200");
    expect(t).toContain("sample_report");
    expect(t).toContain("gcode_state"); // the sample_report body
  });

  test("per-stage judgement is independent (partial failure)", async () => {
    // TCP half-down → Stage 1 fails; report missing → Stage 2 fails; ftps ok → Stage 3 passes.
    const { app, repo } = build({
      diag: allPassDiag({ ftps_reachable: false, report_received: false }),
    });
    await app.request("/ui/verify/run-diagnostics", { method: "POST" });
    const p = progress(repo)!;
    expect(p.stages["1"]!.status).toBe("failed"); // mqtt_reachable && ftps_reachable
    expect(p.stages["2"]!.status).toBe("failed"); // mqtt_auth_ok && report_received
    expect(p.stages["3"]!.status).toBe("passed"); // ftps_auth_ok
  });

  test("a failed check is 要確認 (amber), never red — red is reserved for stop", async () => {
    const { app } = build({ diag: allPassDiag({ mqtt_reachable: false }) });
    const t = await text(app, "/ui/verify/run-diagnostics", { method: "POST" });
    expect(t).toContain("badge amber");
    expect(t).not.toContain("badge red");
  });
});

describe("POST /ui/verify/check-status (Stage 4)", () => {
  test("IDLE → Stage 4 合格", async () => {
    const { app, repo } = build({ status: status({ gcode_state: "IDLE" }) });
    await app.request("/ui/verify/check-status", { method: "POST" });
    expect(progress(repo)!.stages["4"]!.status).toBe("passed");
  });

  test("non-IDLE → Stage 4 要確認", async () => {
    const { app, repo } = build({ status: status({ gcode_state: "RUNNING", printing: true }) });
    await app.request("/ui/verify/check-status", { method: "POST" });
    expect(progress(repo)!.stages["4"]!.status).toBe("failed");
  });
});

describe("POST /api/verify/dry-run (Stage 5)", () => {
  test("400 without confirmed:true", async () => {
    const { app, spies } = build();
    expect((await app.request("/api/verify/dry-run", { method: "POST" })).status).toBe(400);
    expect((await app.request("/api/verify/dry-run", json({ confirmed: false }))).status).toBe(400);
    expect(spies.dryRuns).toBe(0);
  });

  test("confirmed + idle printer → 200 and startDryRun invoked once", async () => {
    const { app, spies } = build();
    const res = await app.request("/api/verify/dry-run", json({ confirmed: true }));
    expect(res.status).toBe(200);
    expect(spies.dryRuns).toBe(1);
  });

  test("409 while the printer is busy — no dispatch (double-run guard)", async () => {
    const { app, spies } = build({ status: status({ gcode_state: "RUNNING", printing: true }) });
    const res = await app.request("/api/verify/dry-run", json({ confirmed: true }));
    expect(res.status).toBe(409);
    expect(spies.dryRuns).toBe(0);
  });

  test("startDryRun throwing (unsafe gcode guard) surfaces as 500, not a crash", async () => {
    const { app } = build({ dryRunThrows: true });
    const res = await app.request("/api/verify/dry-run", json({ confirmed: true }));
    expect(res.status).toBe(500);
  });

  test("no includeSwap field → startDryRun called with includeSwap=false (backward compatible)", async () => {
    const { app, spies } = build();
    const res = await app.request("/api/verify/dry-run", json({ confirmed: true }));
    expect(res.status).toBe(200);
    expect(spies.dryRunSwapArgs).toEqual([false]);
  });

  test("includeSwap:true is forwarded to startDryRun", async () => {
    const { app, spies } = build();
    const res = await app.request("/api/verify/dry-run", json({ confirmed: true, includeSwap: true }));
    expect(res.status).toBe(200);
    expect(spies.dryRunSwapArgs).toEqual([true]);
  });

  test("includeSwap:false is forwarded as false (explicit opt-out)", async () => {
    const { app, spies } = build();
    const res = await app.request("/api/verify/dry-run", json({ confirmed: true, includeSwap: false }));
    expect(res.status).toBe(200);
    expect(spies.dryRunSwapArgs).toEqual([false]);
  });
});

describe("POST /api/verify/eject (Stage 6)", () => {
  test("invokes the injected eject", async () => {
    const { app, spies } = build();
    const res = await app.request("/api/verify/eject", { method: "POST" });
    expect(res.status).toBe(200);
    expect(spies.ejects).toBe(1);
  });
});

describe("POST /ui/verify/stage/:n (manual mark + note)", () => {
  test("persists status + note and echoes it in the fragment", async () => {
    const { app, repo } = build();
    const t = await text(app, "/ui/verify/stage/7", form("status=passed&note=" + encodeURIComponent("実印刷OK")));
    const p = progress(repo)!;
    expect(p.stages["7"]!.status).toBe("passed");
    expect(p.stages["7"]!.note).toBe("実印刷OK");
    expect(t).toContain("実印刷OK"); // note re-rendered in the textarea
  });

  test("manual 要確認 renders amber, not red", async () => {
    const { app } = build();
    const t = await text(app, "/ui/verify/stage/6", form("status=failed"));
    expect(t).toContain("badge amber");
    expect(t).not.toContain("badge red");
  });

  test("an unknown stage number is ignored, not a crash", async () => {
    const { app, repo } = build();
    const res = await app.request("/ui/verify/stage/99", form("status=passed"));
    expect(res.status).toBe(200);
    // nothing persisted for stage 99
    const p = progress(repo);
    if (p) expect(p.stages["99"]).toBeUndefined();
  });
});

describe("progress persistence (zod round-trip + corruption recovery)", () => {
  test("state survives across app instances sharing the repo", async () => {
    const { app, repo } = build();
    await app.request("/ui/verify/run-diagnostics", { method: "POST" });
    await app.request("/ui/verify/stage/7", form("status=passed&note=done"));

    // A fresh app on the same repo must see the persisted progress.
    const app2 = createVerifyApp({
      repo,
      runDiagnostics: async () => allPassDiag(),
      printerStatus: () => status(),
      startDryRun: async () => {},
      eject: async () => {},
    });
    const t = await text(app2, "/ui/verify");
    expect(t).toContain("badge green"); // stage 1-3 + 7 passed
    expect(t).toContain("done"); // stage 7 note
  });

  test("unparseable JSON falls back to a clean initial state (no crash)", async () => {
    const { app, repo } = build();
    repo.setSetting("verify_progress", "{ this is not valid json");
    const res = await app.request("/ui/verify");
    expect(res.status).toBe(200);
    const t = await res.text();
    expect(t).toContain("badge slate"); // all pending
    expect(t).not.toContain("badge green");
  });

  test("valid JSON of the wrong shape also falls back to initial", async () => {
    const { app, repo } = build();
    repo.setSetting("verify_progress", JSON.stringify({ stages: "not-an-object" }));
    const res = await app.request("/ui/verify");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("badge slate");
  });

  test("recovery does not silently overwrite the corrupt value on a read", async () => {
    const { app, repo } = build();
    repo.setSetting("verify_progress", "garbage");
    await app.request("/ui/verify");
    // a plain GET must not mutate storage — only writes persist
    expect(repo.getSetting("verify_progress")).toBe("garbage");
  });
});

// ── TEMPORARY (実機検証用 — 確認後に削除, task#16) ─────────────────────────────
// 一時検証セクション: 撮影テスト / Discord写真報告 / 自動キャプチャのアーム。
import { createVerifyApp as createVerifyAppTemp } from "../../src/api/verify-routes.ts";
import { openDb as openDbTemp } from "../../src/db/index.ts";

describe("TEMPORARY verify photo-test endpoints", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xaa, 0xff, 0xd9]);

  function tempApp(overrides: Partial<Parameters<typeof createVerifyAppTemp>[0]> = {}) {
    const { repo } = openDbTemp(":memory:");
    const armed: boolean[] = [];
    const sent: string[] = [];
    const app = createVerifyAppTemp({
      repo,
      runDiagnostics: async () => { throw new Error("unused"); },
      printerStatus: () => ({ printing: false, job_id: null, percent: 0, remaining_min: 0, gcode_state: "IDLE" }),
      startDryRun: async () => {},
      eject: async () => {},
      testSnapshot: async () => JPEG,
      sendPhotoReport: async (_j, note) => { sent.push(note); return true; },
      armAutoCapture: (a) => { armed.push(a); },
      autoCaptureState: () => ({ armed: armed[armed.length - 1] ?? false, fired: null }),
      ...overrides,
    });
    return { app, armed, sent };
  }

  test("test-snapshot captures and the preview route serves the held JPEG", async () => {
    const { app } = tempApp();
    const res = await app.request("/api/verify/test-snapshot", { method: "POST" });
    expect(res.status).toBe(200);
    const img = await app.request("/api/verify/test-snapshot.jpg");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await img.arrayBuffer()).equals(JPEG)).toBe(true);
  });

  test("photo report without a prior shot => 400; after a shot => sends", async () => {
    const { app, sent } = tempApp();
    expect((await app.request("/api/verify/test-photo-report", { method: "POST" })).status).toBe(400);
    await app.request("/api/verify/test-snapshot", { method: "POST" });
    const res = await app.request("/api/verify/test-photo-report", { method: "POST" });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("実機検証テスト");
  });

  test("camera failure degrades to 502 (never 500/throw)", async () => {
    const { app } = tempApp({ testSnapshot: async () => null });
    const res = await app.request("/api/verify/test-snapshot", { method: "POST" });
    expect(res.status).toBe(502);
  });

  test("auto-capture arm/disarm reaches the dep and re-renders the fragment", async () => {
    const { app, armed } = tempApp();
    const body = new FormData();
    body.append("armed", "1");
    const res = await app.request("/ui/verify/auto-capture", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(armed).toEqual([true]);
    expect(await res.text()).toContain("tempPhotoTest");
  });

  test("the temp section is absent when the temp deps are not wired", async () => {
    const { repo } = openDbTemp(":memory:");
    const app = createVerifyAppTemp({
      repo,
      runDiagnostics: async () => { throw new Error("unused"); },
      printerStatus: () => ({ printing: false, job_id: null, percent: 0, remaining_min: 0, gcode_state: "IDLE" }),
      startDryRun: async () => {},
      eject: async () => {},
    });
    const page = await (await app.request("/verify")).text();
    expect(page).not.toContain("tempPhotoTest");
    expect((await app.request("/api/verify/test-snapshot", { method: "POST" })).status).toBe(404);
  });
});
