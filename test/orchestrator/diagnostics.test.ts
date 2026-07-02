import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as netCreateServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualPrinter } from "../../src/stub/virtual-printer.ts";
import { StubMqttServer } from "../../src/stub/mqtt-server.ts";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { runDiagnostics, type DiagnosticsOptions } from "../../src/orchestrator/diagnostics.ts";
import { createDiagnosticsApp } from "../../src/api/diagnostics-routes.ts";

const SERIAL = "STUB0009";
const ACCESS = "stub-access-code";
const CERT_DIR = join(process.cwd(), "certs");

let printer: VirtualPrinter;
let mqttServer: StubMqttServer;
let ftpsServer: StubFtpsServer;
let mqttPort: number;
let ftpsPort: number;
let uploadDir: string;

const target = (over: Partial<DiagnosticsOptions> = {}): DiagnosticsOptions => ({
  host: "127.0.0.1",
  mqttPort,
  ftpsPort,
  serial: SERIAL,
  accessCode: ACCESS,
  // Short budget so a stuck check can't drag the suite out; the happy path is
  // event-driven and finishes well under this.
  timeoutMs: 2000,
  ...over,
});

/** A port that is guaranteed to have nothing listening on it. */
async function closedPort(): Promise<number> {
  const srv = netCreateServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "diag-"));
  printer = new VirtualPrinter({ serial: SERIAL, speedFactor: 60000, fullSpoolGrams: 1000 }, [
    { index: 2, color: "#FF0000FF", type: "PLA", remaining_g: 800 },
  ]);
  // accessCode enables the stub's MQTT auth, so a bad code is actually rejected.
  mqttServer = new StubMqttServer(printer, { port: 0, certDir: CERT_DIR, accessCode: ACCESS });
  ftpsServer = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  mqttPort = await mqttServer.listen(0);
  ftpsPort = await ftpsServer.listen(0);
});

afterAll(async () => {
  await mqttServer.close();
  await ftpsServer.close();
  rmSync(uploadDir, { recursive: true, force: true });
});

describe("runDiagnostics (spec 20.7)", () => {
  test("all checks pass against the stub; prot_mode is P", async () => {
    const r = await runDiagnostics(target());

    expect(r.mqtt_reachable).toBe(true);
    expect(r.ftps_reachable).toBe(true);
    expect(r.mqtt_auth_ok).toBe(true);
    expect(r.report_received).toBe(true);
    expect(r.ftps_auth_ok).toBe(true);
    // The stub accepts PROT P (and would also accept C); P wins.
    expect(r.prot_mode).toBe("P");
    expect(r.errors).toEqual({});

    // sample_report is the raw print block — evidence for real-hardware triage.
    expect(r.sample_report).not.toBeNull();
    expect(r.sample_report).toHaveProperty("gcode_state");
    // never leak the access code
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });

  test("wrong access code → auth false, ports still reachable", async () => {
    const r = await runDiagnostics(target({ accessCode: "wrong-code" }));

    expect(r.mqtt_reachable).toBe(true);
    expect(r.ftps_reachable).toBe(true);
    expect(r.mqtt_auth_ok).toBe(false);
    expect(r.ftps_auth_ok).toBe(false);
    expect(r.report_received).toBe(false);
    expect(r.prot_mode).toBe("none");
    expect(r.errors.ftps).toBeDefined();
  });

  test("closed ports → reachable false, and the probe does not hang", async () => {
    const dead = await closedPort();
    const started = Date.now();
    const r = await runDiagnostics(
      target({ mqttPort: dead, ftpsPort: dead, timeoutMs: 1500 }),
    );

    expect(r.mqtt_reachable).toBe(false);
    expect(r.ftps_reachable).toBe(false);
    expect(r.mqtt_auth_ok).toBe(false);
    expect(r.ftps_auth_ok).toBe(false);
    // Connection refused is immediate; must not sit until the timeout budget.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("GET /api/diagnostics", () => {
  test("returns the diagnostics verdict as JSON", async () => {
    const app = createDiagnosticsApp({ target: target() });
    const res = await app.request("/api/diagnostics");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Awaited<ReturnType<typeof runDiagnostics>>;
    expect(body.mqtt_reachable).toBe(true);
    expect(body.ftps_auth_ok).toBe(true);
    expect(body.prot_mode).toBe("P");
    expect(body.sample_report).toHaveProperty("gcode_state");
  });

  test("the runner is injectable (no I/O needed to test the wiring)", async () => {
    const canned = {
      host: "printer.local",
      mqtt_reachable: true,
      ftps_reachable: true,
      mqtt_auth_ok: true,
      report_received: true,
      ftps_auth_ok: true,
      prot_mode: "C" as const,
      prot_detail: "PROT P → 536; PROT C → 200",
      sample_report: { gcode_state: "IDLE" },
      errors: {},
    };
    const app = createDiagnosticsApp({ target: target(), run: async () => canned });
    const res = await app.request("/api/diagnostics");
    expect(await res.json()).toEqual(canned);
  });
});
