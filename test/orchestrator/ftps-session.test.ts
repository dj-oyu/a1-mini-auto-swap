// Central FTPS session management (ftps-session.ts): the A1 has effectively
// ONE session slot, so (a) sessions must be serialized process-wide, (b) every
// session must end with a polite QUIT — even when the body throws — and (c) a
// failed session must not deadlock the queue for the next caller.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { isTransientConnectError, withFtpsSession } from "../../src/orchestrator/ftps-session.ts";

const CERT_DIR = join(process.cwd(), "certs");
const ACCESS = "stub-access-code";

let uploadDir: string;
let server: StubFtpsServer;
let port: number;

const opts = () => ({ host: "127.0.0.1", port, accessCode: ACCESS, timeoutMs: 8000 });

beforeAll(async () => {
  uploadDir = mkdtempSync(join(tmpdir(), "ftps-session-"));
  server = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  port = await server.listen(0);
});
afterAll(async () => {
  await server.close().catch(() => {});
  rmSync(uploadDir, { recursive: true, force: true });
});

test("concurrent sessions are serialized — the second body starts only after the first ends", async () => {
  const events: string[] = [];
  const first = withFtpsSession(opts(), async () => {
    events.push("A:start");
    await new Promise((r) => setTimeout(r, 150));
    events.push("A:end");
  });
  const second = withFtpsSession(opts(), async () => {
    events.push("B:start");
  });
  await Promise.all([first, second]);
  expect(events).toEqual(["A:start", "A:end", "B:start"]);
});

test("a throwing body still QUITs, propagates its error, and does not block the next session", async () => {
  let failed = false;
  try {
    await withFtpsSession(opts(), async () => {
      throw new Error("body exploded");
    });
  } catch (e) {
    failed = true;
    expect((e as Error).message).toBe("body exploded");
  }
  expect(failed).toBe(true);

  // The queue must have released; a follow-up session works immediately.
  const pwd = await withFtpsSession(opts(), async (c) => c.pwd());
  expect(typeof pwd).toBe("string");
});

test("a connect failure (nothing listening) rejects but releases the queue", async () => {
  let failed = false;
  try {
    await withFtpsSession({ host: "127.0.0.1", port: 1, accessCode: ACCESS, timeoutMs: 1500 }, async () => {});
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);

  const pwd = await withFtpsSession(opts(), async (c) => c.pwd());
  expect(typeof pwd).toBe("string");
});

test("isTransientConnectError classifies retry-worthy failures", () => {
  expect(isTransientConnectError(new Error("Timeout (control socket)"))).toBe(true);
  expect(isTransientConnectError(new Error("connect ECONNREFUSED 1.2.3.4:990"))).toBe(true);
  expect(isTransientConnectError(new Error("530 Login incorrect"))).toBe(false);
});
