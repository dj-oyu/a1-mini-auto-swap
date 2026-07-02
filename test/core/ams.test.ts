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

  // SUSPECT: amsMatches uses strict string equality on `color`, so case and
  // "#"-prefix differences (e.g. "#ff0000" vs "#FF0000", or "FF0000" vs
  // "#FF0000") are treated as a mismatch. This test pins that current
  // behavior; if upstream gcode/AMS color strings are not normalized to a
  // single canonical form before calling amsMatches, this could produce
  // spurious blocking_job escalations (INV-PENDING-02) for what a human
  // would consider the same color.
  test("color string case/format variance is NOT normalized — differing case is a mismatch (characterization, see SUSPECT above)", () => {
    const required: FilamentReq[] = [{ slot: 0, color: "#FF0000", type: "PLA" }];
    const loadedLowercase: LoadedTray[] = [{ slot: 0, color: "#ff0000", type: "PLA" }];
    expect(amsMatches(required, loadedLowercase)).toBe(false);

    const loadedNoHash: LoadedTray[] = [{ slot: 0, color: "FF0000", type: "PLA" }];
    expect(amsMatches(required, loadedNoHash)).toBe(false);
  });
});
