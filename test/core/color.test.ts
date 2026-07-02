// Color normalization (spec 5/14 boundary reality): 3MF project_settings uses
// "#RRGGBB", the AMS MQTT wire uses "RRGGBBAA" (no '#', with alpha,
// docs/bambu-protocol-notes.md), and case varies by tool. Comparing raw strings
// caused false mismatches → spurious blocking_job escalations (the // SUSPECT
// declared in test/core/ams.test.ts). Canonical form: "#RRGGBB" uppercase.
import { describe, expect, test } from "bun:test";
import { normalizeColor, sameColor } from "../../src/core/color.ts";

describe("normalizeColor", () => {
  test("canonicalizes to uppercase #RRGGBB", () => {
    expect(normalizeColor("#ff0000")).toBe("#FF0000");
    expect(normalizeColor("#FF0000")).toBe("#FF0000");
    expect(normalizeColor("ff0000")).toBe("#FF0000");
    expect(normalizeColor("FF0000")).toBe("#FF0000");
  });

  test("drops the AMS wire's alpha byte (RRGGBBAA)", () => {
    expect(normalizeColor("00AE42FF")).toBe("#00AE42");
    expect(normalizeColor("#00ae42ff")).toBe("#00AE42");
  });

  test("expands #RGB shorthand", () => {
    expect(normalizeColor("#f00")).toBe("#FF0000");
    expect(normalizeColor("0af")).toBe("#00AAFF");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeColor(" #ff0000 ")).toBe("#FF0000");
  });

  test("non-hex tokens pass through (trimmed, uppercased) instead of throwing", () => {
    expect(normalizeColor("rainbow")).toBe("RAINBOW");
    expect(normalizeColor("")).toBe("");
  });
});

describe("sameColor", () => {
  test("matches across notation variants", () => {
    expect(sameColor("#FF0000", "#ff0000")).toBe(true);
    expect(sameColor("#FF0000", "FF0000")).toBe(true);
    expect(sameColor("#FF0000", "FF0000FF")).toBe(true); // AMS wire vs 3MF
    expect(sameColor("#f00", "FF0000FF")).toBe(true);
  });

  test("different colors stay different", () => {
    expect(sameColor("#FF0000", "#FF0001")).toBe(false);
    expect(sameColor("#FF0000", "0000FFFF")).toBe(false);
  });
});
