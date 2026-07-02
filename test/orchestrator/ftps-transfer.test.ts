// In-process PROT C upload engine (ftps-transfer.ts). Why it exists: Bun's
// TLSSocket sends no close_notify on end() (raw-record sniff, 実測 2026-07-02),
// so a PROT P data channel closed by us looks truncated to real A1 firmware
// and the 226 never comes. A plaintext data socket terminates with a plain
// FIN — no TLS close semantics involved. These tests drive the engine against
// the stub's sniffing data channel (plaintext path).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { uploadBytes } from "../../src/orchestrator/ftps-client.ts";
import { parsePasv227 } from "../../src/orchestrator/ftps-transfer.ts";
import type { UploadProgress } from "../../src/orchestrator/ftps-transfer.ts";

const CERT_DIR = join(process.cwd(), "certs");
const ACCESS = "stub-access-code";

let uploadDir: string;
let server: StubFtpsServer;
let port: number;

const opts = () => ({ host: "127.0.0.1", port, accessCode: ACCESS, timeoutMs: 8000 });

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "ftps-transfer-"));
  server = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  port = await server.listen(0);
});
afterAll(async () => {
  await server.close().catch(() => {});
  rmSync(uploadDir, { recursive: true, force: true });
});

test("parsePasv227 decodes host and port", () => {
  expect(parsePasv227("Entering Passive Mode (192,168,1,69,7,232)")).toEqual({
    host: "192.168.1.69",
    port: 7 * 256 + 232,
  });
  expect(() => parsePasv227("garbage")).toThrow(/unparseable/);
});

test("small upload over the plain data channel is stored byte-identically", async () => {
  const payload = Buffer.from("PK\x03\x04 plain-channel payload"); // zip-like leading bytes
  await uploadBytes(opts(), payload, "plain-small.gcode.3mf");
  expect(server.uploadedFiles()).toContain("plain-small.gcode.3mf");
  expect(readFileSync(join(uploadDir, "plain-small.gcode.3mf")).equals(payload)).toBe(true);
});

test("large upload (>64KiB, multiple chunks) is stored byte-identically", async () => {
  const payload = randomBytes(300 * 1024);
  await uploadBytes(opts(), payload, "plain-large.gcode.3mf");
  expect(readFileSync(join(uploadDir, "plain-large.gcode.3mf")).equals(payload)).toBe(true);
});

test("onProgress reports monotonic bytesSent up to totalBytes (transfer-monitor hook)", async () => {
  const payload = randomBytes(200 * 1024);
  const seen: UploadProgress[] = [];
  await uploadBytes({ ...opts(), onProgress: (p) => seen.push(p) }, payload, "plain-progress.gcode.3mf");
  expect(seen.length).toBeGreaterThan(1); // chunked → multiple callbacks
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]!.bytesSent).toBeGreaterThanOrEqual(seen[i - 1]!.bytesSent);
    expect(seen[i]!.totalBytes).toBe(payload.length);
  }
  expect(seen[seen.length - 1]!.bytesSent).toBe(payload.length);
});

// Backward compatibility of the stub's sniffing channel: a TLS-wrapping client
// (basic-ftp under PROT P) must still work — the first-byte sniff routes it
// through the internal TLS listener. Covered by the existing
// test/stub/ftps-server.test.ts suite (INV-FTPS-05 and STOR tests), which
// still runs basic-ftp's own uploadFrom.
