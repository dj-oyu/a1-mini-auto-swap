// Eject-job G-code (spec 6/9/19, INV-MQTT-02): after an abort/failure the
// nozzle position is undefined, so a dedicated "homing + swap sequence only"
// program returns the mechanism to a safe state. Shares the dry-rehearsal
// safety rules: home before any absolute move, no heaters, no extrusion,
// motors off at the end.
import { describe, expect, test } from "bun:test";
import { buildEjectGcode } from "../../src/core/eject-gcode.ts";

const SWAP = "G1 Z180 F3000\nM400";

describe("buildEjectGcode", () => {
  test("homes before any G1 (INV-DRY-03 analog — never move absolute unhomed)", () => {
    const g = buildEjectGcode(SWAP);
    const g28 = g.indexOf("G28");
    const firstG1 = g.indexOf("G1 ");
    expect(g28).toBeGreaterThanOrEqual(0);
    expect(firstG1).toBeGreaterThan(g28);
  });

  test("contains the swap sequence verbatim", () => {
    const g = buildEjectGcode(SWAP);
    expect(g).toContain("G1 Z180 F3000");
    expect(g).toContain("M400");
  });

  test("no heater commands and no extrusion (INV-DRY-01/02 analog)", () => {
    const g = buildEjectGcode(SWAP);
    expect(g).not.toMatch(/M10[49]|M1[49]0/); // M104/M109/M140/M190
    for (const line of g.split("\n")) {
      expect(line).not.toMatch(/^G1 .*E[-\d]/); // no E-axis word on moves
    }
  });

  test("ends with motors off (M84)", () => {
    const g = buildEjectGcode(SWAP);
    const lines = g.trim().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^M84/);
  });

  test("resolves {name} placeholders in the swap snippet (INV-INJECT-02)", () => {
    const g = buildEjectGcode("G1 Z{eject_z} F3000", { eject_z: "180" });
    expect(g).toContain("G1 Z180 F3000");
    expect(g).not.toContain("{eject_z}");
  });
});
