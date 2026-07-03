import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createLogsApp, type LogsAppDeps } from "../../src/api/logs-routes.ts";
import { createAuth } from "../../src/api/auth.ts";

let logDir: string;
let mqttLogDir: string;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "logs-route-log-"));
  mqttLogDir = mkdtempSync(join(tmpdir(), "logs-route-mqtt-"));
});
afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
  rmSync(mqttLogDir, { recursive: true, force: true });
});

const DATE = "2026-07-03";

function writeStream(dir: string, prefix: string, records: Array<Record<string, unknown>>): void {
  const name = prefix ? `${prefix}-${DATE}.jsonl` : `${DATE}.jsonl`;
  writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function app(overrides: Partial<LogsAppDeps> = {}): Hono {
  return createLogsApp({ logDir, mqttLogDir, mqttLogEnabled: false, ...overrides });
}

async function getJson(a: Hono, path: string): Promise<{ status: number; body: any }> {
  const res = await a.request(path);
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
}

describe("GET /api/logs", () => {
  test("returns the app stream's records newest-first with the streams list", async () => {
    writeStream(logDir, "app", [
      { time: 1, level: "info", msg: "first" },
      { time: 2, level: "warn", msg: "second" },
    ]);
    const { status, body } = await getJson(app(), "/api/logs?stream=app");
    expect(status).toBe(200);
    expect(body.stream).toBe("app");
    expect(body.streams).toEqual(["app", "state"]); // report hidden (MQTT_LOG off)
    expect(body.records.map((r: any) => r.msg)).toEqual(["second", "first"]);
  });

  test("filters by MINIMUM level (warn drops debug/info)", async () => {
    writeStream(logDir, "app", [
      { time: 1, level: "debug", msg: "d" },
      { time: 2, level: "info", msg: "i" },
      { time: 3, level: "warn", msg: "w" },
      { time: 4, level: "error", msg: "e" },
    ]);
    const { body } = await getJson(app(), "/api/logs?stream=app&level=warn");
    expect(body.records.map((r: any) => r.msg)).toEqual(["e", "w"]);
  });

  test("case-insensitive text search over message + fields", async () => {
    writeStream(logDir, "app", [
      { time: 1, level: "info", msg: "job dispatched", jobId: 42 },
      { time: 2, level: "info", msg: "camera relay up", filename: "PLATE.3mf" },
    ]);
    const byMsg = await getJson(app(), "/api/logs?stream=app&q=DISPATCH");
    expect(byMsg.body.records.map((r: any) => r.msg)).toEqual(["job dispatched"]);
    const byField = await getJson(app(), "/api/logs?stream=app&q=plate.3mf");
    expect(byField.body.records.map((r: any) => r.msg)).toEqual(["camera relay up"]);
  });

  test("respects the limit param", async () => {
    writeStream(
      logDir,
      "app",
      Array.from({ length: 10 }, (_, i) => ({ time: i, level: "info", msg: `m${i}` })),
    );
    const { body } = await getJson(app(), "/api/logs?stream=app&limit=3");
    expect(body.records).toHaveLength(3);
    expect(body.records[0].msg).toBe("m9"); // newest first
  });

  test("redacts secret-keyed fields defensively", async () => {
    writeStream(logDir, "app", [{ time: 1, level: "info", msg: "connect", accessCode: "12345678" }]);
    const { body } = await getJson(app(), "/api/logs?stream=app");
    expect(body.records[0].accessCode).toBe("[REDACTED]");
    expect(JSON.stringify(body)).not.toContain("12345678");
  });

  test("report stream is HIDDEN and 404s when MQTT_LOG is off", async () => {
    writeStream(mqttLogDir, "", [{ ts: 1, gcode_state: "RUNNING" }]);
    const { status, body } = await getJson(app({ mqttLogEnabled: false }), "/api/logs?stream=report");
    expect(status).toBe(404);
    expect(body.streams).toEqual(["app", "state"]);
  });

  test("report stream is available and readable when MQTT_LOG is on", async () => {
    writeStream(mqttLogDir, "", [
      { ts: 1, gcode_state: "RUNNING", mc_percent: 10 },
      { ts: 2, gcode_state: "FINISH" },
    ]);
    const { status, body } = await getJson(app({ mqttLogEnabled: true }), "/api/logs?stream=report");
    expect(status).toBe(200);
    expect(body.streams).toContain("report");
    // Raw records have gcode_state and no msg — the reader returns them verbatim.
    expect(body.records[0].gcode_state).toBe("FINISH");
  });
});

describe("GET /api/logs auth gate", () => {
  test("401 without a token when AUTH_TOKEN gating is installed", async () => {
    writeStream(logDir, "app", [{ time: 1, level: "info", msg: "x" }]);
    const guarded = new Hono();
    guarded.use("*", createAuth("s3cret"));
    guarded.route("/", app());
    const res = await guarded.request("/api/logs?stream=app");
    expect(res.status).toBe(401);
    const ok = await guarded.request("/api/logs?stream=app", { headers: { authorization: "Bearer s3cret" } });
    expect(ok.status).toBe(200);
  });
});

describe("GET /logs (viewer page)", () => {
  test("renders an HTML document with stream tabs, level filter and search box", async () => {
    const res = await app().request("/logs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const t = await res.text();
    expect(t).toContain("<!doctype html>");
    expect(t).toContain('name="stream"');
    expect(t).toContain('name="level"');
    expect(t).toContain('name="q"');
    expect(t).toContain("/ui/logs"); // htmx polling target
    expect(t).toContain("ログ"); // nav
  });

  test("offers the report stream option only when MQTT_LOG is on", async () => {
    const off = await (await app({ mqttLogEnabled: false }).request("/logs")).text();
    expect(off).not.toContain('value="report"');
    const on = await (await app({ mqttLogEnabled: true }).request("/logs")).text();
    expect(on).toContain('value="report"');
  });
});

describe("GET /ui/logs (htmx fragment)", () => {
  test("a row shows the level, message and time", async () => {
    writeStream(logDir, "app", [{ time: Date.parse("2026-07-03T08:15:30Z"), level: "warn", msg: "runout" }]);
    const t = await (await app().request("/ui/logs?stream=app")).text();
    expect(t).toContain("log-table");
    expect(t).toContain("WARN"); // level badge, uppercased
    expect(t).toContain("runout"); // message
    expect(t).toContain("08:15:30"); // formatted time
    expect(t).toContain("lvl-warn"); // colour-coded class
  });

  test("empty stream renders the empty-state, not an error", async () => {
    const t = await (await app().request("/ui/logs?stream=state")).text();
    expect(t).toContain("ログがありません");
  });

  test("expandable extra fields render as monospace JSON in a details block", async () => {
    writeStream(logDir, "app", [{ time: 1, level: "info", msg: "state_change", event: "state_change", from: "RUNNING", to: "PAUSE" }]);
    const t = await (await app().request("/ui/logs?stream=app")).text();
    expect(t).toContain("<details");
    expect(t).toContain("詳細");
    expect(t).toContain("&quot;to&quot;"); // JSON of extra fields, HTML-escaped
  });
});
