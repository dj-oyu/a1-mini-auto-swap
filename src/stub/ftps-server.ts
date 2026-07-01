/**
 * Phase 2 (NOT YET IMPLEMENTED): in-process implicit-FTPS server fronting the
 * printer-stub's upload channel, mirroring bambuddy's `ftp_server.py` wire
 * behavior. See docs/bambu-protocol-notes.md, section
 * "FTPS（ftp_server.py）— Phase 2 実装仕様" for the full comparison table this
 * class must satisfy — every method below throws until that phase lands.
 *
 * Key facts from that table (the "本A1スタブが採る値" column unless noted):
 * - Port 990, implicit TLS — the TLS handshake starts immediately on TCP
 *   connect, there is no plaintext "AUTH TLS" negotiation.
 * - TLS 1.2 only, matching bambuddy (BambuStudio broke mid-transfer on 1.3).
 * - USER is always "bblp"; PASS must equal the configured LAN access code
 *   (bambuddy compares with `hmac.compare_digest`, i.e. constant-time).
 * - STOR writes into `uploadDir`, sanitizing the remote path to its basename
 *   (`Path(arg).name` in bambuddy) — no directory traversal — in 64KiB
 *   chunks, capped at 4GiB.
 * - PROT P is accepted ("200 Protection level set to Private").
 * - ⚠️ PROT C is ALSO accepted here — this is the intentional, A1-specific
 *   deviation from bambuddy (which replies "536 not supported" and rejects
 *   it). Real A1/A1 mini firmware is documented (spec 20.6) to fall back to
 *   a plaintext data channel when a client insists on `PROT P` behavior
 *   isn't sticking. This stub reproduces that fallback so an orchestrator's
 *   FTPS client can be exercised against both PROT P and PROT C data
 *   channels — see docs/bambu-protocol-notes.md's "★最重要の相違点" callout.
 *
 * TODO(Phase 2): implement with `node:tls` (implicit, reusing `ensureCerts`
 * from ./tls.ts like StubMqttServer does) plus a minimal FTP control-command
 * parser (USER/PASS/PROT/PASV|EPSV/STOR) and a PASV/EPSV data-connection
 * listener that honors the negotiated PROT level (TLS for P, plaintext for
 * C).
 */
export interface FtpsServerOptions {
  /** Directory holding the TLS cert/key pair; reuse `ensureCerts` from ./tls.ts, same as StubMqttServer. */
  certDir: string;
  /** LAN access code. PASS must match this exactly (protocol notes table row "PASS"). */
  accessCode: string;
  /** Directory STOR'd files are written into, basename-sanitized (protocol notes table row "STOR"). */
  uploadDir: string;
}

export class StubFtpsServer {
  /**
   * Stores configuration only; does not touch the filesystem or network yet.
   * TODO(Phase 2): ensureCerts(opts.certDir) for the implicit TLS listener
   * and mkdir opts.uploadDir if it doesn't exist.
   */
  constructor(private readonly opts: FtpsServerOptions) {}

  /**
   * Start listening for implicit-FTPS control connections.
   *
   * @param port Port to bind; 990 in production, 0 lets the OS pick (tests).
   * @returns the bound port, mirroring StubMqttServer.listen's resolve-with-port shape.
   *
   * TODO(Phase 2): `tls.createServer({ key, cert, minVersion: "TLSv1.2",
   * maxVersion: "TLSv1.2", ciphers: "HIGH:AES256-GCM-SHA384:AES128-GCM-SHA256:!aNULL:!MD5:!RC4" })`
   * and drive a per-connection FSM: USER "bblp" -> PASS <accessCode> ->
   * [PROT P | PROT C, both accepted] -> PASV/EPSV -> STOR.
   */
  listen(_port: number): Promise<number> {
    throw new Error("not implemented: Phase 2 FTPS");
  }

  /**
   * Stop listening and close all open control and data connections.
   * TODO(Phase 2): close the control listener, then any live data sockets,
   * mirroring StubMqttServer.close's shutdown-then-resolve shape.
   */
  close(): Promise<void> {
    throw new Error("not implemented: Phase 2 FTPS");
  }

  /**
   * Basenames of files successfully STOR'd since the server started, in
   * upload order. Lets tests assert on what landed in `uploadDir` without
   * reading the filesystem directly.
   * TODO(Phase 2): push the sanitized basename onto an internal array once a
   * STOR transfer completes.
   */
  uploadedFiles(): string[] {
    throw new Error("not implemented: Phase 2 FTPS");
  }
}
