// Eject-job G-code (spec 6/9/19, INV-MQTT-02). After a stop/failure the nozzle
// position is undefined, so the recovery path sends a dedicated print that only
// homes and runs the plate-swap sequence, returning the mechanism to a safe
// state. Pure string building; packaging into a .gcode.3mf is the injection/
// adapter (eject-threemf.ts).
//
// Safety rules shared with the dry-rehearsal generator: home before any
// absolute move, no heater commands, no extrusion, motors off at the end.

import { resolvePlaceholders } from "./gcode-inject.ts";

/**
 * Build the eject program: G28 → swap sequence → M84. `{name}` placeholders in
 * the snippet are resolved from `vars` (INV-INJECT-02 — never emit a raw known
 * placeholder; unknown ones are left intact with the resolver's warning).
 */
export function buildEjectGcode(swapSequence: string, vars: Record<string, string> = {}): string {
  const snippet = resolvePlaceholders(swapSequence, vars).text.trim();
  return [
    "G28 ; home all axes (position is undefined after a stop)",
    "G90 ; absolute positioning",
    snippet,
    "M84 ; disable motors",
  ].join("\n") + "\n";
}
