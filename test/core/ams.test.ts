import { describe, expect, test } from "bun:test";
import { amsMatches, type FilamentReq, type LoadedTray } from "../../src/core/ams.ts";

describe("amsMatches (spec 13 filament_confirm)", () => {
  test("exact match on slot/color/type => true (INV-PENDING-01)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loaded: LoadedTray[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    expect(amsMatches(required, loaded)).toBe(true);
  });

  test("color mismatch => false (INV-PENDING-02)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loaded: LoadedTray[] = [{ slot: 0, color: "#0000FF", type: "PLA" }];
    expect(amsMatches(required, loaded)).toBe(false);
  });

  test("type mismatch => false (INV-PENDING-02)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loaded: LoadedTray[] = [{ slot: 0, color: "#FF0000", type: "PETG" }];
    expect(amsMatches(required, loaded)).toBe(false);
  });

  test("slot mismatch => false (a same color/type tray in the wrong slot does not satisfy demand) (INV-PENDING-02)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loaded: LoadedTray[] = [{ slot: 1, color: "#FF0000", type: "PLA" }];
    expect(amsMatches(required, loaded)).toBe(false);
  });

  test("empty required list => true (vacuously satisfied, no demand to confirm) (INV-PENDING-01)", () => {
    const required: FilamentReq[] = [];
    const loaded: LoadedTray[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    expect(amsMatches(required, loaded)).toBe(true);
  });

  test("empty loaded list with non-empty required => false (INV-PENDING-02)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loaded: LoadedTray[] = [];
    expect(amsMatches(required, loaded)).toBe(false);
  });

  test("surplus loaded trays beyond what's required do not block a match => true (INV-PENDING-01)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loaded: LoadedTray[] = [
      { slot: 0, color: "#FF0000", type: "PLA" },
      { slot: 1, color: "#00FF00", type: "PETG" },
      { slot: 2, color: "#0000FF", type: "ABS" },
    ];
    expect(amsMatches(required, loaded)).toBe(true);
  });

  test("all required slots present => true (INV-PENDING-01)", () => {
    const required: FilamentReq[] = [
      { slot: 0, color: "#FF0000", type: "PLA" },
      { slot: 1, color: "#00FF00", type: "PETG" },
    ];
    const loaded: LoadedTray[] = [
      { slot: 0, color: "#FF0000", type: "PLA" },
      { slot: 1, color: "#00FF00", type: "PETG" },
    ];
    expect(amsMatches(required, loaded)).toBe(true);
  });

  test("one of multiple required slots missing => false (INV-PENDING-02)", () => {
    const required: FilamentReq[] = [
      { slot: 0, color: "#FF0000", type: "PLA" },
      { slot: 1, color: "#00FF00", type: "PETG" },
    ];
    const loaded: LoadedTray[] = [
      { slot: 0, color: "#FF0000", type: "PLA" },
      // slot 1 missing from loaded state
    ];
    expect(amsMatches(required, loaded)).toBe(false);
  });

  // Resolves the former // SUSPECT: colors are now compared via
  // normalizeColor (core/color.ts), so notation variance between the 3MF
  // ("#RRGGBB") and the AMS wire ("RRGGBBAA", docs/bambu-protocol-notes.md)
  // no longer causes spurious blocking_job escalations (INV-PENDING-01/02).
  test("color notation variance (case / '#' / AMS alpha suffix) still counts as a match", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    expect(amsMatches(required, [{ slot: 0, color: "#ff0000", type: "PLA" }])).toBe(true);
    expect(amsMatches(required, [{ slot: 0, color: "FF0000", type: "PLA" }])).toBe(true);
    expect(amsMatches(required, [{ slot: 0, color: "FF0000FF", type: "PLA" }])).toBe(true);
    // a genuinely different color is still a mismatch
    expect(amsMatches(required, [{ slot: 0, color: "#FF0001", type: "PLA" }])).toBe(false);
  });
});
