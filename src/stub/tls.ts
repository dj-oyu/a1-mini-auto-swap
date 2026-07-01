import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface TlsMaterial {
  key: Buffer;
  cert: Buffer;
}

/**
 * Load a self-signed cert/key pair from `dir`, generating it with the system
 * openssl on first use. No Docker, no manual setup — the stub mints its own
 * throwaway TLS material (the printer cert is never verified anyway: spec 2
 * "証明書検証は無効化").
 */
export function ensureCerts(dir: string): TlsMaterial {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true });
    const res = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath,
        "-out", certPath,
        "-days", "3650",
        "-subj", "/CN=bambu-stub",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
    if (res.status !== 0) {
      throw new Error(
        `openssl failed to generate certs: ${res.stderr?.toString() ?? "unknown error"}`,
      );
    }
  }

  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
