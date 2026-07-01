// Bambu MQTT wire message shapes (spec ch9). Shared protocol model depended on
// by BOTH the stub (which produces them) and the orchestrator adapters (which
// consume them) — neither depends on the other. Field names confirmed against
// bambuddy virtual_printer/mqtt_server.py (see docs/bambu-protocol-notes.md).

/** gcode_state values reported by the printer (spec 9, 20.3). */
export type GcodeState = "IDLE" | "PREPARE" | "RUNNING" | "PAUSE" | "FINISH" | "FAILED";

/** HMS error entry as the printer reports it (spec 9). */
export interface HmsError {
  attr: number;
  code: number;
}

/** An incoming MQTT `print` command, command == "project_file" (spec 9). */
export interface ProjectFileCommand {
  sequence_id?: string;
  command: "project_file";
  /** e.g. "Metadata/plate_1.gcode" */
  param: string;
  /** e.g. "ftp:///cache/{job_id}.gcode.3mf" */
  url: string;
  use_ams: boolean;
  /** MUST be 4 elements (spec 9, INV-MQTT-01) */
  ams_mapping: number[];
  bed_leveling?: boolean;
  flow_cali?: boolean;
  vibration_cali?: boolean;
}

/** The `print` sub-object of the status report (faithful Bambu subset). */
export interface PrintReport {
  /** identifies this as a status push on the report topic */
  command: "push_status";
  /** message counter; 0 for pushes (real firmware increments) */
  msg: number;
  gcode_state: GcodeState;
  /** coarse stage code; "-1" when idle (stringified int, per real firmware) */
  mc_print_stage: string;
  /** minutes remaining (spec 9: mc_remaining_time) */
  mc_remaining_time: number;
  /** 0..100 percent complete */
  mc_percent: number;
  layer_num: number;
  total_layer_num: number;
  subtask_name: string;
  nozzle_temper: number;
  bed_temper: number;
  ams: AmsReport;
  hms: HmsError[];
  /** echoed from the command that produced this state, aids correlation */
  sequence_id: string;
}

/** AMS section of the report. Real firmware sends *incremental* deltas that the
 *  client must merge (bambuddy _merge_ams_dict); this stub always emits the full
 *  state, so the orchestrator's merge logic is exercised separately. */
export interface AmsReport {
  ams: Array<{
    id: string;
    humidity: string;
    temp: string;
    tray: Array<{
      id: string;
      tray_color: string;
      tray_type: string;
      /** 0..100 percent, -1 unknown (real printer never reports grams) */
      remain: number;
    }>;
  }>;
  /** which physical AMS units exist (hex bitfield) */
  ams_exist_bits: string;
  /** which trays hold filament (hex bitfield) */
  tray_exist_bits: string;
  /** currently loaded tray id, "255" when none */
  tray_now: string;
  /** target tray id, "255" when none */
  tray_tar: string;
}

/** Command acknowledgement published on the report topic in response to a
 *  `print` command (bambuddy replies {command, result:"SUCCESS", msg:0}). */
export interface CommandAck {
  print: {
    command: string;
    result: "SUCCESS" | "FAILED";
    reason?: string;
    sequence_id: string;
    msg: number;
  };
}

/** Full report envelope published on the report topic. */
export interface StatusReport {
  print: PrintReport;
}
