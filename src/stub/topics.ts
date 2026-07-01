// Bambu MQTT topic + command conventions, isolated here so refining them
// against the real protocol (or bambuddy's virtual_printer) is a one-file change.
//
// Real Bambu printers use:
//   - client -> printer commands on  device/{serial}/request
//   - printer -> client reports  on  device/{serial}/report
//   - a full status dump is requested with a `pushing`/`pushall` command.

export function requestTopic(serial: string): string {
  return `device/${serial}/request`;
}

export function reportTopic(serial: string): string {
  return `device/${serial}/report`;
}

/** Shape of an inbound command envelope; only the parts the stub acts on. */
export interface InboundCommand {
  print?: {
    command?: string; // "project_file" | "stop" | "pause" | "resume" | "gcode_line"
    sequence_id?: string;
    [k: string]: unknown;
  };
  pushing?: {
    command?: string; // "pushall"
    sequence_id?: string;
  };
}
