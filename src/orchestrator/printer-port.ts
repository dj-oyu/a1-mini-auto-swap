import type { JobRow } from "../db/types.ts";

/**
 * The printer-facing side of dispatch, abstracted so the dispatcher's decision
 * logic (slice 3b) is unit-testable with a fake. The real adapter (slice 3c)
 * performs the FTPS upload + MQTT project_file for startPrint, and the
 * stop + dedicated eject job for ejectAndReset (spec 6/9).
 */
export interface PrinterPort {
  /** Upload + start printing a job (FTPS → MQTT project_file). */
  startPrint(job: JobRow): Promise<void>;
  /** Return the mechanism to a safe state after a failure/abort (homing + swap). */
  ejectAndReset(): Promise<void>;
}
