// FTPS upload via the system curl binary (ftps-curl.ts). curl is the only
// client that completes a STOR against real A1 firmware (TLS data channel +
// close_notify, which Bun's TLS cannot emit — 実測 2026-07-02). These tests
// drive real curl against the in-process stub FTPS server, so they need curl
// on PATH; they self-skip with a clear note if it is absent (CI images have it).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { uploadBytes } from "../../src/orchestrator/ftps-client.ts";
import { CurlNotFoundError, uploadViaCurl } from "../../src/orchestrator/ftps-curl.ts";
import type { UploadProgressSample } from "../../src/orchestrator/upload-progress-throttle.ts";

const CERT_DIR = join(process.cwd(), "certs");
const ACCESS = "stub-access-code";
const HAS_CURL = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0;

let uploadDir: string;
let server: StubFtpsServer;
let port: number;

const opts = () => ({ host: "127.0.0.1", port, accessCode: ACCESS, timeoutMs: 15_000 });

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "ftps-curl-test-"));
  server = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  port = await server.listen(0);
});
afterAll(async () => {
  await server.close().catch(() => {});
  rmSync(uploadDir, { recursive: true, force: true });
});

test.if(HAS_CURL)("small upload is stored byte-identically via curl", async () => {
  const payload = Buffer.from("PK\x03\x04 curl upload payload");
  await uploadBytes(opts(), payload, "curl-small.gcode.3mf");
  expect(server.uploadedFiles()).toContain("curl-small.gcode.3mf");
  expect(readFileSync(join(uploadDir, "curl-small.gcode.3mf")).equals(payload)).toBe(true);
}, 20_000);

test.if(HAS_CURL)("large upload (>64KiB, multiple stdin chunks) is byte-identical", async () => {
  const payload = randomBytes(300 * 1024);
  await uploadBytes(opts(), payload, "curl-large.gcode.3mf");
  expect(readFileSync(join(uploadDir, "curl-large.gcode.3mf")).equals(payload)).toBe(true);
}, 25_000);

test.if(HAS_CURL)("onProgress reports monotonic bytesSent up to totalBytes", async () => {
  const payload = randomBytes(200 * 1024);
  const seen: UploadProgressSample[] = [];
  await uploadBytes({ ...opts(), onProgress: (p) => seen.push(p) }, payload, "curl-progress.gcode.3mf");
  expect(seen.length).toBeGreaterThan(1);
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]!.bytesSent).toBeGreaterThanOrEqual(seen[i - 1]!.bytesSent);
    expect(seen[i]!.totalBytes).toBe(payload.length);
  }
  expect(seen[seen.length - 1]!.bytesSent).toBe(payload.length);
}, 25_000);

test.if(HAS_CURL)("a wrong access code fails (curl non-zero), file not stored", async () => {
  let failed = false;
  try {
    await uploadBytes({ ...opts(), accessCode: "totally-wrong" }, Buffer.from("x"), "curl-bad.gcode.3mf");
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(server.uploadedFiles()).not.toContain("curl-bad.gcode.3mf");
}, 20_000);

test.if(HAS_CURL)("an already-aborted signal rejects without storing", async () => {
  const ac = new AbortController();
  ac.abort();
  let msg = "";
  try {
    await uploadViaCurl(Buffer.from("x"), "curl-aborted.gcode.3mf", { ...opts(), signal: ac.signal });
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("aborted");
  expect(server.uploadedFiles()).not.toContain("curl-aborted.gcode.3mf");
}, 20_000);

test("missing curl binary raises an actionable CurlNotFoundError", async () => {
  let err: unknown;
  try {
    await uploadViaCurl(Buffer.from("x"), "nope.3mf", {
      host: "127.0.0.1",
      port,
      accessCode: ACCESS,
      curlPath: "definitely-not-a-real-binary-xyz",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CurlNotFoundError);
  expect((err as Error).message).toContain("install curl");
}, 20_000);

if (!HAS_CURL) {
  test("curl not found on PATH — upload integration tests skipped (install curl to run them)", () => {
    expect(HAS_CURL).toBe(false);
  });
}
