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

/** Discover the plate gcode entries (Metadata/plate_N.gcode, excluding .md5),
 *  sorted NUMERICALLY by plate integer (plate_2 before plate_10) — a bare
 *  lexicographic .sort() would order plate_1, plate_10, plate_2, which drives a
 *  wrong palette-chip / listPlates order for a multi-plate export. */
export function findPlateGcodes(files: Record<string, Uint8Array>): string[] {
  return Object.keys(files)
    .filter((n) => /^Metadata\/plate_\d+\.gcode$/i.test(n))
    .sort((a, b) => plateNumOf(a) - plateNumOf(b));
}

/** Extract the plate integer from a "…/plate_N.…" path (0 when unmatched). */
function plateNumOf(path: string): number {
  const m = /plate_(\d+)\./i.exec(path);
  return m ? Number(m[1]) : 0;
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

/** A plate to offer in the read-only 3D PREVIEW. Unlike {@link listPlates}
 *  (printable, gcode-backed), this enumerates plates for ANY 3mf — including a
 *  PROJECT 3mf (a-d.3mf, Letters) that has geometry + model_settings plates but
 *  NO Metadata/plate_N.gcode and therefore cannot be printed. `printable` is
 *  true only for gcode-backed plates; the print-time selection stays on
 *  {@link listPlates}, so a project-3mf preview never makes a job dispatchable. */
export interface PreviewPlate {
  /** e.g. "plate_1" — pass to /api/plate-mesh?plate=… (maps to model_settings plater_id). */
  plate: string;
  /** true ⇒ a Metadata/plate_N.gcode exists and this plate can be dispatched. */
  printable: boolean;
  /** static per-plate print-time estimate in seconds, when known (gcode only). */
  estimatedSeconds: number | null;
}

/**
 * Enumerate the plates to show in the read-only preview: the gcode plates when
 * the archive is sliced (printable), else the model_settings <plate> entries of
 * a project 3mf (preview-only). Returns [] when neither is present. This is the
 * PREVIEW source; {@link listPlates} remains the PRINTABLE source.
 */
export function listPreviewPlates(threemf: Buffer): PreviewPlate[] {
  const files = unzipSync(threemf);
  const gcodes = findPlateGcodes(files);
  if (gcodes.length > 0) {
    return gcodes.map((gpath) => {
      const plate = gpath.slice("Metadata/".length, -".gcode".length);
      return { plate, printable: true, estimatedSeconds: readPlateEstimateSeconds(files, plate) };
    });
  }
  return listModelSettingsPlates(files);
}

/** Which read-only 3D preview renderer a cached archive should use. */
export type PreviewKind = "mesh" | "gcode" | "thumb";

/**
 * Decide the preview source for a cached archive (Part A 3-tier selection):
 *  - "mesh":  renderable geometry present — a PROJECT 3mf (inline
 *    `3D/3dmodel.model` mesh, external `3D/Objects/*.model` parts, or
 *    `model_settings.config` plater_id plates) → the Three.js mesh viewer
 *    (`/api/plate-mesh`, `/model`).
 *  - "gcode": NO mesh, but ≥1 `Metadata/plate_N.gcode` — a sliced, PRINTABLE
 *    `.gcode.3mf` (Bambu strips the mesh on slice) → the gcode-preview toolpath
 *    viewer (`/api/queue/:id/gcode`).
 *  - "thumb": neither → the embedded plate PNG only.
 *
 * Only the file LISTING + two small parts are decompressed (fflate `filter`
 * observes every entry name but inflates only `3D/3dmodel.model` and
 * `Metadata/model_settings.config`), so a multi-hundred-MB multi-plate archive
 * is never fully inflated just to pick a renderer. Never throws (→ "thumb").
 */
export function previewKind(threemf: Buffer): PreviewKind {
  const names: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(threemf, {
      filter: (f) => {
        names.push(f.name);
        return f.name === "3D/3dmodel.model" || f.name === "Metadata/model_settings.config";
      },
    });
  } catch {
    return "thumb";
  }
  // External geometry parts ⇒ a real project 3mf.
  if (names.some((n) => /^3D\/Objects\/.*\.model$/i.test(n))) return "mesh";
  // Inline mesh in the root model.
  const root = files["3D/3dmodel.model"];
  if (root) {
    try {
      if (/<mesh[\s>]/.test(strFromU8(root))) return "mesh";
    } catch {
      /* unreadable root → fall through */
    }
  }
  // Sliced: at least one printable plate gcode ⇒ gcode toolpath preview.
  if (names.some((n) => /^Metadata\/plate_\d+\.gcode$/i.test(n))) return "gcode";
  // Project 3mf whose geometry is external but whose plater_id plates we can
  // still enumerate (preview-only, no gcode) ⇒ mesh preview.
  const settings = files["Metadata/model_settings.config"];
  if (settings && listModelSettingsPlates(files).length > 0) return "mesh";
  return "thumb";
}

/** Enumerate plater_id plates from Metadata/model_settings.config (project 3mf).
 *  These are preview-only (no gcode ⇒ not printable). Sorted by plater_id. */
function listModelSettingsPlates(files: Record<string, Uint8Array>): PreviewPlate[] {
  const raw = files["Metadata/model_settings.config"];
  if (!raw) return [];
  let xml: string;
  try {
    xml = strFromU8(raw);
  } catch {
    return [];
  }
  const ids: number[] = [];
  const pre = /<plate>([\s\S]*?)<\/plate>/g;
  let p: RegExpExecArray | null;
  while ((p = pre.exec(xml)) !== null) {
    const m = /key="plater_id"\s+value="(\d+)"/.exec(p[1]!);
    if (m) ids.push(Number(m[1]));
  }
  return [...new Set(ids)]
    .sort((a, b) => a - b)
    .map((n) => ({ plate: `plate_${n}`, printable: false, estimatedSeconds: null }));
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
 * Extract ONE plate's render PNG (per-plate thumbnail for the sequence builder):
 * prefer `Metadata/<plate>.png` (a printable multi-plate export ships one per
 * plate — plate_1.png … plate_26.png), fall back to `Metadata/top_<N>.png` when
 * that variant is present, else null. Bounded (single dict lookups) and never
 * throws — a malformed archive or unknown plate degrades to null so the chip's
 * <img> just removes itself and the label alone remains.
 */
export function extractPlateThumbnail(threemf: Buffer, plate: string): Uint8Array | null {
  const m = /^plate_(\d+)$/i.exec(plate);
  if (!m) return null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(threemf);
  } catch {
    return null;
  }
  return files[`Metadata/${plate}.png`] ?? files[`Metadata/top_${m[1]}.png`] ?? null;
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
