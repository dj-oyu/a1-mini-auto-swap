import type { AddressInfo } from "node:net";
import {
  createServer as tlsCreateServer,
  type Server as TlsServer,
  type TLSSocket,
} from "node:tls";
import { createWriteStream, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureCerts } from "./tls.ts";

/**
 * In-process implicit-FTPS server fronting the printer-stub's upload channel,
 * mirroring bambuddy's `ftp_server.py` wire behavior. See
 * docs/bambu-protocol-notes.md, "FTPS（ftp_server.py）— Phase 2 実装仕様".
 *
 * - Port 990 (implicit TLS) in production; TLS handshake starts immediately on
 *   TCP connect — no plaintext "AUTH TLS" negotiation.
 * - TLS 1.2 only (BambuStudio broke mid-transfer on 1.3).
 * - USER is always "bblp"; PASS must equal the configured LAN access code.
 * - STOR writes into `uploadDir`, sanitizing the remote path to its basename
 *   (`Path(arg).name`) — no directory traversal — capped at 4GiB.
 * - PROT P is accepted ("200 ... Private").
 * - ⚠️ PROT C is ALSO accepted here (INV-FTPS-05) — the intentional A1-specific
 *   deviation from bambuddy (which replies "536"). Note: TLS-capable FTPS
 *   clients (e.g. basic-ftp) reuse the control TLS session on the data channel
 *   regardless of PROT, so the stub secures the data channel when the client
 *   initiates TLS on it. A genuinely plaintext-only PROT C client would need
 *   sniff-based downgrade, tracked as a future refinement.
 */
export interface FtpsServerOptions {
  certDir: string;
  accessCode: string;
  uploadDir: string;
}

const TLS_VERSION = { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } as const;
const TLS_CIPHERS = "HIGH:AES256-GCM-SHA384:AES128-GCM-SHA256:!aNULL:!MD5:!RC4";
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

interface ConnState {
  user: string;
  authed: boolean;
  prot: "C" | "P";
  dataListener: TlsServer | null;
  dataSocket: Promise<TLSSocket> | null;
}

export class StubFtpsServer {
  private server: TlsServer | null = null;
  private key: Buffer | null = null;
  private cert: Buffer | null = null;
  private readonly controls = new Set<TLSSocket>();
  private readonly dataListeners = new Set<TlsServer>();
  private readonly uploaded: string[] = [];

  constructor(private readonly opts: FtpsServerOptions) {}

  /** Start the implicit-FTPS listener. Resolves with the bound port. */
  listen(port: number): Promise<number> {
    const { key, cert } = ensureCerts(this.opts.certDir);
    this.key = key;
    this.cert = cert;
    mkdirSync(this.opts.uploadDir, { recursive: true });

    this.server = tlsCreateServer(
      { key, cert, ...TLS_VERSION, ciphers: TLS_CIPHERS },
      (socket) => this.handleControl(socket),
    );

    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        resolve((this.server!.address() as AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.controls) c.destroy();
    for (const l of this.dataListeners) l.close();
    this.controls.clear();
    this.dataListeners.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }

  uploadedFiles(): string[] {
    return [...this.uploaded];
  }

  // ── control connection ─────────────────────────────────────────────────────

  private handleControl(control: TLSSocket): void {
    this.controls.add(control);
    const state: ConnState = {
      user: "",
      authed: false,
      prot: "C",
      dataListener: null,
      dataSocket: null,
    };

    const reply = (code: number, text: string) => control.write(`${code} ${text}\r\n`);
    reply(220, "stub FTPS ready");

    let buf = "";
    const lines: string[] = [];
    let processing = false;
    const pump = async () => {
      if (processing) return;
      processing = true;
      while (lines.length) {
        // eslint-disable-next-line no-await-in-loop
        await this.dispatch(lines.shift()!, state, control, reply);
      }
      processing = false;
    };

    control.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      let idx: number;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
      void pump();
    });

    const cleanup = () => {
      if (state.dataListener) {
        this.dataListeners.delete(state.dataListener);
        state.dataListener.close();
        state.dataListener = null;
      }
      this.controls.delete(control);
    };
    control.on("close", cleanup);
    control.on("error", cleanup);
  }

  private async dispatch(
    line: string,
    state: ConnState,
    control: TLSSocket,
    reply: (code: number, text: string) => void,
  ): Promise<void> {
    const sp = line.indexOf(" ");
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase().trim();
    const arg = sp < 0 ? "" : line.slice(sp + 1);

    switch (cmd) {
      case "USER":
        state.user = arg.trim();
        reply(331, "Password required");
        break;

      case "PASS":
        if (state.user === "bblp" && safeEqual(arg, this.opts.accessCode)) {
          state.authed = true;
          reply(230, "Login successful");
        } else {
          state.authed = false;
          reply(530, "Login incorrect");
        }
        break;

      case "SYST":
        reply(215, "UNIX Type: L8");
        break;

      case "FEAT":
        control.write(
          "211-Features:\r\n UTF8\r\n PASV\r\n EPSV\r\n PBSZ\r\n PROT\r\n211 End\r\n",
        );
        break;

      case "OPTS":
        reply(200, "OK");
        break;

      case "TYPE":
        reply(200, `Type set to ${arg.trim() || "I"}`);
        break;

      case "PWD":
        reply(257, '"/" is the current directory');
        break;

      case "CWD":
        reply(250, "OK");
        break;

      case "PBSZ":
        reply(200, "PBSZ=0");
        break;

      case "PROT":
        // Accept BOTH P and C. C is the A1 fallback (INV-FTPS-05), the
        // deliberate opposite of bambuddy's "536 not supported".
        if (arg.trim().toUpperCase() === "P") {
          state.prot = "P";
          reply(200, "Protection level set to Private");
        } else {
          state.prot = "C";
          reply(200, "Protection level set to Clear");
        }
        break;

      case "EPSV": {
        const port = await this.openPassive(state);
        reply(229, `Entering Extended Passive Mode (|||${port}|)`);
        break;
      }

      case "PASV": {
        const port = await this.openPassive(state);
        const p1 = Math.floor(port / 256);
        const p2 = port % 256;
        reply(227, `Entering Passive Mode (127,0,0,1,${p1},${p2})`);
        break;
      }

      case "STOR":
        await this.handleStor(arg, state, reply);
        break;

      case "QUIT":
        reply(221, "Goodbye");
        control.end();
        break;

      case "NOOP":
        reply(200, "OK");
        break;

      default:
        reply(502, "Command not implemented");
        break;
    }
  }

  // ── passive data channel ────────────────────────────────────────────────────

  /** Open a fresh passive data listener; returns the bound port. The data
   *  connection is TLS (a tls.createServer, the same Bun-supported path as the
   *  control listener) because TLS-capable clients secure the data channel by
   *  reusing the control session regardless of PROT. */
  private openPassive(state: ConnState): Promise<number> {
    if (state.dataListener) {
      this.dataListeners.delete(state.dataListener);
      state.dataListener.close();
      state.dataListener = null;
    }

    let resolveSock!: (s: TLSSocket) => void;
    state.dataSocket = new Promise<TLSSocket>((res) => {
      resolveSock = res;
    });

    const listener = tlsCreateServer(
      { key: this.key!, cert: this.cert!, ...TLS_VERSION, ciphers: TLS_CIPHERS },
      (sock) => resolveSock(sock),
    );
    this.dataListeners.add(listener);
    state.dataListener = listener;

    return new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        resolve((listener.address() as AddressInfo).port);
      });
    });
  }

  private async handleStor(
    arg: string,
    state: ConnState,
    reply: (code: number, text: string) => void,
  ): Promise<void> {
    if (!state.authed) {
      reply(530, "Not logged in");
      return;
    }
    if (!state.dataSocket) {
      reply(425, "Use PASV/EPSV first");
      return;
    }

    const name = basename(arg.trim());
    reply(150, "Opening data connection");

    try {
      const sock = await state.dataSocket;
      const target = join(this.opts.uploadDir, name);
      await receiveTo(sock, target);
      this.uploaded.push(name);
      reply(226, "Transfer complete");
    } catch {
      reply(550, "Transfer failed");
    } finally {
      if (state.dataListener) {
        this.dataListeners.delete(state.dataListener);
        state.dataListener.close();
        state.dataListener = null;
      }
      state.dataSocket = null;
    }
  }
}

/** Stream a data socket to `target`, chunked, enforcing the 4GiB cap. */
function receiveTo(sock: TLSSocket, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(target);
    let total = 0;
    let aborted = false;

    sock.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        aborted = true;
        sock.destroy();
        ws.destroy();
        reject(new Error("upload exceeds 4GiB cap"));
        return;
      }
      ws.write(chunk);
    });
    sock.on("end", () => ws.end());
    sock.on("error", (e) => {
      if (!aborted) reject(e);
    });
    ws.on("finish", () => {
      if (!aborted) resolve();
    });
    ws.on("error", (e) => {
      if (!aborted) reject(e);
    });
  });
}

/** Constant-time-ish string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
