// FTPS session hygiene (実測 2026-07-02): the real A1 holds an abruptly-closed
// session's slot for ~1-2 min, so the next connect times out / is refused
// transiently. uploadBytes must (a) retry transient connect failures with
// backoff and (b) not retry hard failures like a wrong access code.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";
import { uploadBytes } from "../../src/orchestrator/ftps-client.ts";

const CERT_DIR = join(process.cwd(), "certs");
const ACCESS = "stub-access-code";
let uploadDir: string;

beforeAll(() => {
  uploadDir = mkdtempSync(join(tmpdir(), "ftps-retry-"));
});
afterAll(() => {
  rmSync(uploadDir, { recursive: true, force: true });
});

/** Reserve an OS-assigned free port, then release it for reuse. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

test("uploadBytes retries a transient connect failure and succeeds once the server is up", async () => {
  const port = await freePort();
  const server = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });

  // Attempt 1 hits a closed port (ECONNREFUSED → transient). Bring the server
  // up during the retry delay; attempt 2 must succeed.
  const bring = (async () => {
    await new Promise((r) => setTimeout(r, 200));
    await server.listen(port);
  })();

  try {
    await uploadBytes(
      { host: "127.0.0.1", port, accessCode: ACCESS, retries: 4, retryDelayMs: 400 },
      Buffer.from("retry payload"),
      "retry-test.gcode.3mf",
    );
    await bring;
    expect(server.uploadedFiles()).toContain("retry-test.gcode.3mf");
    expect(readFileSync(join(uploadDir, "retry-test.gcode.3mf"), "utf8")).toBe("retry payload");
  } finally {
    await server.close().catch(() => {});
  }
}, 15000);

test("uploadBytes does NOT retry a hard auth failure (wrong access code fails fast)", async () => {
  const server = new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS, uploadDir });
  const port = await server.listen(0);
  try {
    const t0 = Date.now();
    let failed = false;
    try {
      await uploadBytes(
        { host: "127.0.0.1", port, accessCode: "totally-wrong", retries: 3, retryDelayMs: 5_000 },
        Buffer.from("x"),
        "nope.3mf",
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // one attempt only: no 5s retry delay was consumed
    expect(Date.now() - t0).toBeLessThan(4_000);
  } finally {
    await server.close().catch(() => {});
  }
}, 15000);
