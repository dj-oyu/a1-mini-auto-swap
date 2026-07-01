// Virtual-printer internal types. The Bambu wire shapes (GcodeState, HmsError,
// ProjectFileCommand, PrintReport, AmsReport, StatusReport, CommandAck) live in
// ../protocol/messages.ts and are re-exported here for convenience so existing
// stub imports (from "./types.ts") keep working.
export type * from "../protocol/messages.ts";

/** A single AMS/BMCU tray slot. Internally we track grams (spec 20.4 __control
 *  sets remaining_g); the MQTT report exposes `remain` as a 0..100 percent to
 *  stay faithful to the real printer, which never reports grams. */
export interface Tray {
  /** slot index 0..3 */
  index: number;
  /** 8-hex RRGGBBAA, or "" if empty */
  color: string;
  /** material, e.g. "PLA" | "PETG" | "" */
  type: string;
  /** remaining filament in grams; 0 == runout */
  remaining_g: number;
}

/** Fault injection request (spec 20.5). */
export type FaultCategory = "printer" | "swap" | "transient";
export type FaultTiming = "now" | "next_print" | "on_state_transition:FINISH";

export interface FaultInjection {
  category: FaultCategory;
  timing: FaultTiming;
}

/** What we know about the print currently loaded/running. */
export interface ActiveJob {
  subtask_name: string;
  param: string;
  url: string;
  ams_mapping: number[];
  /** total simulated minutes for this print */
  totalMinutes: number;
}

/** Tunables for the virtual printer's simulated behavior. */
export interface VirtualPrinterConfig {
  serial: string;
  /** spec 20.3: real-minute compression factor. 1000 => 1 sim-minute per 60ms */
  speedFactor: number;
  /** grams assumed == 100% remain in the report mapping */
  fullSpoolGrams: number;
}
