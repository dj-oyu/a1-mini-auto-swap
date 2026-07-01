import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  MACHINE_START_MARKER,
  gcodeMd5,
  injectEndSequence,
  injectStartSequence,
  resolvePlaceholders,
} from "../../src/core/gcode-inject.ts";

const SWAP = "G1 Z180 F3000\nM400";

describe("injectEndSequence (INV-INJECT-04)", () => {
  test("appends the snippet after the last original line, preserving it", () => {
    const gcode = "G1 X10\nG1 Y10\nM104 S0\n";
    const out = injectEndSequence(gcode, SWAP);
    expect(out).toContain("M104 S0"); // original last line kept
    const lines = out.trimEnd().split("\n");
    expect(lines.slice(-2)).toEqual(["G1 Z180 F3000", "M400"]); // snippet at the very end
    expect(out.indexOf("M104 S0")).toBeLessThan(out.indexOf("G1 Z180"));
  });
});

describe("injectStartSequence (INV-INJECT-05)", () => {
  test("injects right after the marker when present, no warning", () => {
    const gcode = `; header\n${MACHINE_START_MARKER}\nG28\n`;
    const { text, warnings } = injectStartSequence(gcode, "M104 S200");
    expect(warnings).toHaveLength(0);
    expect(text.indexOf("M104 S200")).toBeGreaterThan(text.indexOf(MACHINE_START_MARKER));
    expect(text.indexOf("M104 S200")).toBeLessThan(text.indexOf("G28"));
  });

  test("prepends and warns when the marker is absent", () => {
    const { text, warnings } = injectStartSequence("G28\nG1 X0\n", "M104 S200");
    expect(warnings[0]).toMatch(/not found/);
    expect(text.startsWith("M104 S200")).toBe(true);
  });
});

describe("resolvePlaceholders (INV-INJECT-02)", () => {
  test("resolves known placeholders; no known raw placeholder survives", () => {
    const { text, warnings } = resolvePlaceholders("start {name} bed {bed_temp}", {
      name: "plate_1",
      bed_temp: "60",
    });
    expect(text).toBe("start plate_1 bed 60");
    expect(text).not.toMatch(/\{name\}|\{bed_temp\}/);
    expect(warnings).toHaveLength(0);
  });

  test("leaves unknown placeholders intact with a warning (does not fail)", () => {
    const { text, warnings } = resolvePlaceholders("hi {mystery}", { name: "x" });
    expect(text).toBe("hi {mystery}");
    expect(warnings[0]).toMatch(/unknown placeholder/);
  });
});

describe("gcodeMd5 (INV-INJECT-01)", () => {
  test("matches a straight md5 of the bytes", () => {
    const gcode = "G1 X10\nG1 Y10\n";
    expect(gcodeMd5(gcode)).toBe(createHash("md5").update(Buffer.from(gcode)).digest("hex"));
  });

  test("the recomputed sidecar reflects the injected content, not the original", () => {
    const original = "G1 X10\nM104 S0\n";
    const injected = injectEndSequence(original, SWAP);
    const before = gcodeMd5(original);
    const after = gcodeMd5(injected);
    expect(after).not.toBe(before); // sidecar must be recomputed
    expect(after).toBe(createHash("md5").update(Buffer.from(injected)).digest("hex"));
  });
});
