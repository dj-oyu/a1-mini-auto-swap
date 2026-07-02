import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { injectEndSequence, resolvePlaceholders } from "../core/gcode-inject.ts";
import { gcodeMd5 } from "./md5.ts";

// .gcode.3mf processing (spec 5/7): a ZIP archive. We inject the swap/end
// sequence into a plate's G-code, recompute its .md5 sidecar, and repackage —
// always on a copy, never mutating the input (INV-INJECT-03). Metadata is
// re-extracted from the archive every call, never cached (INV-INJECT-06).

export interface FilamentInfo {
  index: number;
  color: string;
  type: string;
}

export interface InjectOptions {
  /** plate id (e.g. "plate_24"). Default: auto-discover the archive's single
   *  Metadata/plate_N.gcode. A single-plate export from a multi-plate project
   *  keeps its ORIGINAL plate number (実測: a letter sliced from a 26-letter
   *  project shipped only Metadata/plate_24.gcode) — assuming plate_1 fails. */
  plate?: string;
  /** the swap/end sequence to append (may contain {name} placeholders) */
  endSnippet: string;
}

export interface InjectResult {
  bytes: Buffer;
  md5: string;
  /** The plate gcode path inside the archive (e.g. "Metadata/plate_24.gcode").
   *  The MQTT project_file `param` MUST use this, not a hardcoded plate_1. */
  param: string;
  warnings: string[];
}

/** Discover the plate gcode entries (Metadata/plate_N.gcode, excluding .md5). */
export function findPlateGcodes(files: Record<string, Uint8Array>): string[] {
  return Object.keys(files)
    .filter((n) => /^Metadata\/plate_\d+\.gcode$/i.test(n))
    .sort();
}

export interface PlateInfo {
  /** e.g. "plate_24" — the id to pass as InjectOptions.plate. */
  plate: string;
  /** Static per-plate print-time estimate in seconds, when Bambu Studio wrote
   *  a Metadata/{plate}.json sidecar with a `prediction`/`gcode_prediction`
   *  field. null when the sidecar is absent or unparseable — the picker just
   *  omits the estimate for that option (no dependency on plate thumbnails,
   *  which are not embedded for every plate of a multi-plate export). */
  estimatedSeconds: number | null;
}

/**
 * List every plate a `.gcode.3mf` carries (upload-time plate selection): a
 * project exported with "all plates" ships one Metadata/plate_N.gcode per
 * plate. Single-plate archives return a 1-element array — callers only need
 * to offer a picker when this has more than one entry.
 */
export function listPlates(threemf: Buffer): PlateInfo[] {
  const files = unzipSync(threemf);
  return findPlateGcodes(files).map((gpath) => {
    const plate = gpath.slice("Metadata/".length, -".gcode".length);
    return { plate, estimatedSeconds: readPlateEstimateSeconds(files, plate) };
  });
}

/** Best-effort read of a plate's static print-time estimate from its
 *  Metadata/{plate}.json sidecar (Bambu Studio slice-info format — field name
 *  unconfirmed against every studio version, hence the two aliases and the
 *  defensive try/catch: never throws, degrades to null). */
function readPlateEstimateSeconds(files: Record<string, Uint8Array>, plate: string): number | null {
  const raw = files[`Metadata/${plate}.json`];
  if (!raw) return null;
  try {
    const json = JSON.parse(strFromU8(raw)) as { prediction?: unknown; gcode_prediction?: unknown };
    const v = json.prediction ?? json.gcode_prediction;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  } catch {
    return null;
  }
}

/** Re-extract filament colours/types from project_settings.config (spec 5). */
export function extractFilaments(threemf: Buffer): FilamentInfo[] {
  const files = unzipSync(threemf);
  const cfg = files["Metadata/project_settings.config"];
  if (!cfg) return [];
  const json = JSON.parse(strFromU8(cfg)) as { filament_colour?: string[]; filament_type?: string[] };
  const colours = json.filament_colour ?? [];
  const types = json.filament_type ?? [];
  return colours.map((color, index) => ({ index, color, type: types[index] ?? "" }));
}

/**
 * Extract an embedded plate thumbnail PNG (spec 17 §6 — visual pre-print check).
 * Bambu Studio writes several under Metadata/ (plate_1.png, top_1.png, …); we
 * prefer the lit plate render, then fall back to any Metadata PNG. Returns the
 * raw PNG bytes, or null when the archive carries no thumbnail.
 */
export function extractThumbnail(threemf: Buffer): Uint8Array | null {
  const files = unzipSync(threemf);
  const names = Object.keys(files);
  const isPng = (n: string) => /\.png$/i.test(n);
  const preferred =
    names.find((n) => /^Metadata\/plate_\d+\.png$/i.test(n)) ??
    names.find((n) => /^Metadata\/.*\.png$/i.test(n)) ??
    names.find((n) => n.startsWith("Metadata/") && isPng(n)) ??
    names.find(isPng);
  return preferred ? (files[preferred] ?? null) : null;
}

/**
 * Inject the end sequence into `Metadata/{plate}.gcode`, recompute
 * `Metadata/{plate}.gcode.md5`, and return a fresh .gcode.3mf. The input buffer
 * is never modified (INV-INJECT-03); placeholders in the snippet are resolved
 * from the gcode HEADER block (INV-INJECT-02).
 */
export function injectIntoThreemf(threemf: Buffer, opts: InjectOptions): InjectResult {
  const files = unzipSync(threemf);
  const warnings: string[] = [];

  // Resolve the plate gcode path: explicit override, else auto-discover.
  let gpath: string;
  if (opts.plate) {
    gpath = `Metadata/${opts.plate}.gcode`;
  } else {
    const plates = findPlateGcodes(files);
    if (plates.length === 0) throw new Error("no Metadata/plate_N.gcode found in 3mf");
    if (plates.length > 1) warnings.push(`multiple plate gcodes ${plates.join(", ")}; using ${plates[0]}`);
    gpath = plates[0]!;
  }
  const mpath = `${gpath}.md5`;

  const gbytes = files[gpath];
  if (!gbytes) throw new Error(`${gpath} not found in 3mf`);

  const original = strFromU8(gbytes);
  const resolved = resolvePlaceholders(opts.endSnippet, parseHeaderVars(original));
  const injected = injectEndSequence(original, resolved.text);
  const md5 = gcodeMd5(injected);

  const out: Record<string, Uint8Array> = { ...files };
  out[gpath] = strToU8(injected);
  out[mpath] = strToU8(md5);

  return { bytes: Buffer.from(zipSync(out)), md5, param: gpath, warnings: [...warnings, ...resolved.warnings] };
}

/** Parse `; key = value` lines inside the `; HEADER_BLOCK_START..END` block (spec 7). */
function parseHeaderVars(gcode: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const start = gcode.indexOf("; HEADER_BLOCK_START");
  const end = gcode.indexOf("; HEADER_BLOCK_END");
  const block = start >= 0 && end > start ? gcode.slice(start, end) : "";
  for (const line of block.split("\n")) {
    const m = line.match(/^;\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}
