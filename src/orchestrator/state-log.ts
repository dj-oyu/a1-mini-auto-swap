import type { Logger } from "../core/ports.ts";

// State-transition log (obs stream 2): the always-on, low-volume trail that
// makes a filament-runout (or any fault) diagnosable after the fact. It
// subscribes to the raw MQTT `report` events and writes ONE line only when
// something meaningful changed from the previous report — a change in any of:
//   gcode_state · print_error · the set of HMS codes · the AMS tray summary
// A filament runout shows up as RUNNING→PAUSE with a non-zero print_error / a
// new HMS code, so this trail pins down exactly when and why a print paused.
//
// Everything else in a push_status (mc_percent, remaining time, temps) is
// ignored, so a running print does NOT spam this stream.

/** Minimal event source (satisfied structurally by OrchestratorMqttClient, an
 *  EventEmitter). Kept narrow so tests can drive it with a tiny emitter. */
export interface ReportSource {
  on(event: "report", listener: (raw: Record<string, unknown>) => void): unknown;
  off(event: "report", listener: (raw: Record<string, unknown>) => void): unknown;
}

interface TraySummary {
  slot: number;
  type: string;
  color: string;
  remain: number;
}

interface Snapshot {
  gcodeState: string;
  printError: number | null;
  hms: number[]; // sorted unique codes
  ams: TraySummary[];
}

export class StateLog {
  private prev: Snapshot | null = null;
  private readonly onReport = (raw: Record<string, unknown>) => this.handle(raw);

  constructor(
    private readonly source: ReportSource,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.source.on("report", this.onReport);
  }

  stop(): void {
    this.source.off("report", this.onReport);
  }

  private handle(raw: Record<string, unknown>): void {
    const snap = summarize(raw);
    if (this.prev && sameSnapshot(this.prev, snap)) return; // no meaningful change → suppress
    const from = this.prev?.gcodeState ?? null;
    this.prev = snap;

    this.log.info("state_change", {
      event: "state_change",
      from,
      to: snap.gcodeState,
      print_error: snap.printError,
      print_error_hex: snap.printError !== null ? toHex(snap.printError) : null,
      hms: snap.hms,
      hms_hex: snap.hms.map(toHex),
      ams: snap.ams,
    });
  }
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.gcodeState === b.gcodeState &&
    a.printError === b.printError &&
    sameNums(a.hms, b.hms) &&
    JSON.stringify(a.ams) === JSON.stringify(b.ams)
  );
}

function sameNums(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 16-bit-safe hex, uppercased, `0x` prefixed (matches Bambu's print_error /
 *  HMS notation, e.g. 0x0500C010). Uses >>>0 so negatives/large uints render. */
function toHex(n: number): string {
  return "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function summarize(raw: Record<string, unknown>): Snapshot {
  return {
    gcodeState: typeof raw.gcode_state === "string" ? raw.gcode_state : "",
    printError: parsePrintError(raw.print_error),
    hms: parseHms(raw.hms),
    ams: parseAms(raw.ams),
  };
}

/** print_error is a number on the wire, but firmware/tools sometimes hand it as
 *  a "0x…" string — accept both, normalize to a number, undefined/absent → null. */
function parsePrintError(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = v.trim().toLowerCase().startsWith("0x") ? parseInt(v.trim(), 16) : Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseHms(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const codes = v
    .map((h) => (h && typeof h === "object" ? (h as Record<string, unknown>).code : undefined))
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  return [...new Set(codes)].sort((a, b) => a - b);
}

function parseAms(v: unknown): TraySummary[] {
  if (!v || typeof v !== "object") return [];
  const units = (v as Record<string, unknown>).ams;
  if (!Array.isArray(units)) return [];
  const out: TraySummary[] = [];
  for (const unit of units) {
    const trays = unit && typeof unit === "object" ? (unit as Record<string, unknown>).tray : undefined;
    if (!Array.isArray(trays)) continue;
    for (const t of trays) {
      if (!t || typeof t !== "object") continue;
      const tray = t as Record<string, unknown>;
      out.push({
        slot: numOr(tray.id, -1),
        type: typeof tray.tray_type === "string" ? tray.tray_type : "",
        color: typeof tray.tray_color === "string" ? tray.tray_color : "",
        remain: numOr(tray.remain, -1),
      });
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}

function numOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
