import { Client } from "basic-ftp";
import { Readable } from "node:stream";

export interface FtpsUploadOptions {
  host: string;
  port: number;
  accessCode: string;
  username?: string; // default "bblp"
}

/**
 * Upload a local file to the printer's implicit-FTPS cache (spec 2/6). One-shot:
 * connect, STOR, close. A1 firmware may fall back to PROT C (spec 20.6); the
 * stub accepts both, and basic-ftp secures the data channel over the control
 * session either way.
 */
export async function uploadFile(
  opts: FtpsUploadOptions,
  localPath: string,
  remoteName: string,
): Promise<void> {
  const client = new Client();
  try {
    await client.access({
      host: opts.host,
      port: opts.port,
      user: opts.username ?? "bblp",
      password: opts.accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });
    await client.uploadFrom(localPath, remoteName);
  } finally {
    client.close();
  }
}

/** Upload in-memory bytes (used when the artifact is generated, not on disk). */
export async function uploadBytes(
  opts: FtpsUploadOptions,
  data: Buffer,
  remoteName: string,
): Promise<void> {
  const client = new Client();
  try {
    await client.access({
      host: opts.host,
      port: opts.port,
      user: opts.username ?? "bblp",
      password: opts.accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });
    await client.uploadFrom(Readable.from(data), remoteName);
  } finally {
    client.close();
  }
}
