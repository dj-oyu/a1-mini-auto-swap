import { connect as netConnect, type Socket } from "node:net";
import type { Client } from "basic-ftp";

// In-process upload engine over a PLAINTEXT data channel (PROT C).
//
// Why not basic-ftp's uploadFrom: Bun's TLSSocket does not send a TLS
// close_notify on end() (実測 2026-07-02, raw-record sniff: appdata → bare
// FIN, no ALERT record). Real A1 firmware treats a data connection closed
// without close_notify as truncated and never sends the 226 — every PROT P
// upload from Bun therefore hangs. A plaintext data socket has no such
// requirement: TCP FIN is the legitimate terminator. The control channel
// stays TLS (credentials remain encrypted); the payload is gcode on a
// trusted LAN, and PROT C is the A1's own documented fallback (spec 20.6).
//
// Owning the data socket here (instead of inside basic-ftp) is also the
// extension point for server-managed transfer features: onProgress is wired
// now; pause/abort (socket teardown) and resume (REST offset) attach here.

export interface UploadProgress {
  bytesSent: number;
  totalBytes: number;
}

export interface PlainUploadOptions {
  /** Called as chunks are flushed to the data socket (transfer monitor hook). */
  onProgress?: (p: UploadProgress) => void;
  /** Per-phase deadline (PASV reply / data connect / 226), default 20s. */
  timeoutMs?: number;
  /** Data-socket write chunk size, default 64KiB (matches firmware chunking). */
  chunkSize?: number;
}

/** Parse a "227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)" reply. */
export function parsePasv227(message: string): { host: string; port: number } {
  const m = message.match(/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})/);
  if (!m) throw new Error(`unparseable PASV reply: ${message.trim()}`);
  return {
    host: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`,
    port: Number(m[5]) * 256 + Number(m[6]),
  };
}

/**
 * Upload `data` to `remotePath` over an open control session, using PROT C +
 * PASV + a plaintext data socket. Completion = server's 226 on the control
 * channel after our FIN. Throws on any non-2xx/1xx control reply or timeout.
 */
export async function uploadPlainData(
  client: Client,
  data: Buffer,
  remotePath: string,
  opts: PlainUploadOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const chunkSize = opts.chunkSize ?? 64 * 1024;

  const trace = (m: string) => {
    if (process.env.FTPS_TRACE === "1") console.log(`[ftps-transfer] ${m}`);
  };

  // 1. Plaintext data channel. The A1 accepts PROT C (its own fallback mode);
  //    the stub accepts it too (INV-FTPS-05).
  const prot = await client.send("PROT C");
  trace(`PROT C → ${prot.code} ${prot.message.trim()}`);
  if (prot.code >= 300) throw new Error(`PROT C rejected: ${prot.code} ${prot.message}`);

  // 2. Passive endpoint. The A1 rejects EPSV (502, 実測) — PASV only.
  const pasv = await client.send("PASV");
  const { host, port } = parsePasv227(pasv.message);
  trace(`PASV → ${pasv.code} data ${host}:${port}`);
  // PASV host antispoof (same rule as curl's --ftp-skip-pasv-ip default):
  // always connect to the control host, ignore an advertised foreign IP.
  const dataHost = host === "0.0.0.0" ? client.ftp.socket.remoteAddress! : host;

  // 3. STOR is a two-phase exchange (150 → transfer → 226); drive it through
  //    basic-ftp's response loop so control parsing/timeout stay consistent.
  await client.ftp.handle(`STOR ${remotePath}`, (res, task) => {
    if (res instanceof Error) {
      trace(`STOR phase error: ${res.message}`);
      task.reject(res);
      return;
    }
    trace(`STOR ← ${res.code} ${res.message.trim()}`);
    if (res.code === 150 || res.code === 125) {
      // Server is ready — open the plain data connection and stream.
      const socket: Socket = netConnect(port, dataHost);
      const killer = setTimeout(() => {
        socket.destroy(new Error(`data transfer timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.on("error", (e) => {
        clearTimeout(killer);
        task.reject(e);
      });
      socket.on("connect", () => {
        trace(`data socket connected to ${dataHost}:${port} (plain)`);
        let off = 0;
        const writeNext = (): void => {
          while (off < data.length) {
            const chunk = data.subarray(off, Math.min(off + chunkSize, data.length));
            off += chunk.length;
            const ok = socket.write(chunk);
            opts.onProgress?.({ bytesSent: off, totalBytes: data.length });
            if (!ok) {
              socket.once("drain", writeNext);
              return;
            }
          }
          socket.end(); // plain FIN — the legitimate PROT C terminator
          clearTimeout(killer);
        };
        writeNext();
      });
      return; // stay in the handler; wait for the server's 226
    }
    if (res.code === 226 || res.code === 250) {
      task.resolve(res);
      return;
    }
    task.reject(new Error(`STOR failed: ${res.code} ${res.message}`));
  });
}
