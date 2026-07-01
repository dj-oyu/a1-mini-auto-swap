/**
 * RED integration tests for the Phase 2 implicit-FTPS server (StubFtpsServer,
 * src/stub/ftps-server.ts). The class is currently a skeleton — every method
 * throws `new Error("not implemented: Phase 2 FTPS")` — so every test below
 * is EXPECTED TO FAIL today at the `server.listen(0)` call. That failure is
 * the point: these tests pin down the Phase 2 contract described in
 * docs/bambu-protocol-notes.md ("FTPS（ftp_server.py）— Phase 2 実装仕様"),
 * and they should turn green once that server is actually implemented.
 *
 * Do not "fix" these tests by catching the not-implemented error — the whole
 * point of RED-GREEN TDD is that they fail for the right reason until Phase 2
 * lands.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "basic-ftp";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubFtpsServer } from "../../src/stub/ftps-server.ts";

const CERT_DIR = join(process.cwd(), "certs");
const ACCESS_CODE = "stub-access-code";

let uploadDir: string;
let localDir: string;

beforeEach(() => {
  uploadDir = mkdtempSync(join(tmpdir(), "ftps-stub-upload-"));
  localDir = mkdtempSync(join(tmpdir(), "ftps-stub-local-"));
});

afterEach(() => {
  rmSync(uploadDir, { recursive: true, force: true });
  rmSync(localDir, { recursive: true, force: true });
});

function newServer(): StubFtpsServer {
  return new StubFtpsServer({ certDir: CERT_DIR, accessCode: ACCESS_CODE, uploadDir });
}

/**
 * Set up a fresh server + FTP client for one test, run `fn`, and always tear
 * both down — even when `server.listen(0)` throws (today's RED state) or
 * `server.close()` throws in the `finally` (also not implemented yet). The
 * `listen(0)` call is intentionally NOT wrapped in its own try/catch here:
 * letting it throw straight into the test body is what makes these tests
 * fail for the right reason instead of silently no-op'ing.
 */
async function withServer(
  fn: (port: number, client: Client, server: StubFtpsServer) => Promise<void>,
): Promise<void> {
  const server = newServer();
  const client = new Client();
  try {
    const port = await server.listen(0); // RED: throws "not implemented: Phase 2 FTPS"
    await fn(port, client, server);
  } finally {
    client.close();
    try {
      await server.close();
    } catch {
      // close() is unimplemented too; don't let cleanup mask the real failure.
    }
  }
}

test("implicit FTPS: TLS handshake succeeds on the bound port (table row: port 990 implicit, TLS 1.2)", async () => {
  await withServer(async (port, client) => {
    const res = await client.connectImplicitTLS("127.0.0.1", port, { rejectUnauthorized: false });
    expect(res.code).toBeGreaterThanOrEqual(120);
    expect(res.code).toBeLessThan(300);
  });
});

test("USER bblp + correct access code authenticates (table row: PASS == LAN access code)", async () => {
  await withServer(async (port, client) => {
    await client.connectImplicitTLS("127.0.0.1", port, { rejectUnauthorized: false });
    const res = await client.login("bblp", ACCESS_CODE);
    expect(res.code).toBe(230);
  });
});

test("USER bblp + wrong access code is rejected", async () => {
  await withServer(async (port, client) => {
    await client.connectImplicitTLS("127.0.0.1", port, { rejectUnauthorized: false });
    await expect(client.login("bblp", "totally-wrong-code")).rejects.toThrow();
  });
});

test("STOR uploads a file into uploadDir, sanitized to its basename (table row: STOR)", async () => {
  await withServer(async (port, client, server) => {
    await client.access({
      host: "127.0.0.1",
      port,
      user: "bblp",
      password: ACCESS_CODE,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });

    const localFile = join(localDir, "job-1.gcode.3mf");
    const content = "fake 3mf bytes for job-1";
    writeFileSync(localFile, content);

    // Path-traversal attempt in the remote name must be sanitized to its
    // basename (bambuddy: `Path(arg).name`), same as the real device.
    await client.uploadFrom(localFile, "../../evil/job-1.gcode.3mf");

    expect(server.uploadedFiles()).toContain("job-1.gcode.3mf");
    expect(readFileSync(join(uploadDir, "job-1.gcode.3mf"), "utf8")).toBe(content);
  });
});

test("PROT P (private) is accepted (table row: 200 Protection level set to Private)", async () => {
  await withServer(async (port, client) => {
    await client.connectImplicitTLS("127.0.0.1", port, { rejectUnauthorized: false });
    await client.login("bblp", ACCESS_CODE);
    const res = await client.send("PROT P");
    expect(res.code).toBe(200);
  });
});

// ★ Key A1-specific case (docs/bambu-protocol-notes.md "★最重要の相違点", spec 20.6):
// bambuddy answers PROT C with "536 not supported" and rejects it. Real A1 /
// A1 mini firmware instead falls back to a *plaintext* data channel when
// PROT P doesn't stick, so this stub must accept PROT C — the opposite of
// bambuddy's behavior — and the resulting plaintext STOR must still work.
test("PROT C (cleartext) is accepted as an A1 fallback, and the plaintext data channel works", async () => {
  await withServer(async (port, client, server) => {
    await client.connectImplicitTLS("127.0.0.1", port, { rejectUnauthorized: false });
    await client.login("bblp", ACCESS_CODE);

    const protRes = await client.send("PROT C");
    expect(protRes.code).toBe(200);

    const localFile = join(localDir, "plaintext-plate.gcode.3mf");
    const content = "PROT C plaintext upload content";
    writeFileSync(localFile, content);
    await client.uploadFrom(localFile, "plaintext-plate.gcode.3mf");

    expect(server.uploadedFiles()).toContain("plaintext-plate.gcode.3mf");
    expect(readFileSync(join(uploadDir, "plaintext-plate.gcode.3mf"), "utf8")).toBe(content);
  });
});

test("large STOR (>64KiB, exercises chunked writes) uploads intact (table row: 64KiB chunks, 4GiB cap)", async () => {
  await withServer(async (port, client, server) => {
    await client.access({
      host: "127.0.0.1",
      port,
      user: "bblp",
      password: ACCESS_CODE,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });

    const localFile = join(localDir, "big-plate.gcode.3mf");
    const bytes = randomBytes(300 * 1024); // several times the 64KiB chunk size
    writeFileSync(localFile, bytes);

    await client.uploadFrom(localFile, "big-plate.gcode.3mf");

    expect(server.uploadedFiles()).toContain("big-plate.gcode.3mf");
    expect(readFileSync(join(uploadDir, "big-plate.gcode.3mf"))).toEqual(bytes);
  });
});
