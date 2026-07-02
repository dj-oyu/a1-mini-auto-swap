import { createHash } from "node:crypto";

/** MD5 hex of the gcode bytes, for the `.gcode.md5` sidecar (spec 7,
 *  INV-INJECT-01). Lives in injection/ (adapter layer) — core stays free of
 *  node builtins per the CLAUDE.md layer rules. */
export function gcodeMd5(gcode: string | Buffer): string {
  const buf = typeof gcode === "string" ? Buffer.from(gcode, "utf8") : gcode;
  return createHash("md5").update(buf).digest("hex");
}
