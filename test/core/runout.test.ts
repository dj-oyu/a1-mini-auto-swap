import { describe, expect, test } from "bun:test";
import { resolveRunout, type AmsTray, type RunoutPolicy } from "../../src/core/runout.ts";

const RED = "#FF0000";
const BLUE = "#0000FF";

function ctx(policy: RunoutPolicy, trays: AmsTray[], runoutSlot = 0, minThresholdG = 10) {
  return { policy, runoutSlot, trays, minThresholdG };
}

describe("resolveRunout (spec 14)", () => {
  test("manual policy => pending, never auto-switches (INV-RUNOUT-01)", () => {
    const r = resolveRunout(
      ctx("manual", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: RED, type: "PLA", remaining_g: 800 },
      ]),
    );
    expect(r).toEqual({ kind: "pending", reason: "manual_policy" });
  });

  test("same_color_only switches to same type AND same color (INV-RUNOUT-03)", () => {
    const r = resolveRunout(
      ctx("same_color_only", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: BLUE, type: "PLA", remaining_g: 800 }, // wrong color
        { slot: 2, color: RED, type: "PLA", remaining_g: 500 }, // match
      ]),
    );
    expect(r).toEqual({ kind: "switch", toSlot: 2, substitutedColor: null });
  });

  test("same_color_only matches across color notations — AMS 'RRGGBBAA' wire form vs 3MF '#RRGGBB' (INV-RUNOUT-03)", () => {
    const r = resolveRunout(
      ctx("same_color_only", [
        { slot: 0, color: "#FF0000", type: "PLA", remaining_g: 0 },
        { slot: 1, color: "FF0000FF", type: "PLA", remaining_g: 800 }, // same red, wire notation
      ]),
    );
    expect(r).toEqual({ kind: "switch", toSlot: 1, substitutedColor: null });
  });

  test("allow_material_match does NOT record a substitution when only the notation differs (INV-RUNOUT-06)", () => {
    const r = resolveRunout(
      ctx("allow_material_match", [
        { slot: 0, color: "#FF0000", type: "PLA", remaining_g: 0 },
        { slot: 1, color: "ff0000", type: "PLA", remaining_g: 800 }, // same red, different case/#
      ]),
    );
    // same actual color => no false ⚠色代替 flag
    expect(r).toEqual({ kind: "switch", toSlot: 1, substitutedColor: null });
  });

  test("same_color_only with no same-color alt => pending (INV-RUNOUT-05)", () => {
    const r = resolveRunout(
      ctx("same_color_only", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: BLUE, type: "PLA", remaining_g: 800 },
      ]),
    );
    expect(r).toEqual({ kind: "pending", reason: "no_candidate" });
  });

  test("allow_material_match switches on same type even if color differs, records substitution (INV-RUNOUT-04/06)", () => {
    const r = resolveRunout(
      ctx("allow_material_match", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: BLUE, type: "PLA", remaining_g: 800 },
      ]),
    );
    expect(r).toEqual({ kind: "switch", toSlot: 1, substitutedColor: BLUE });
  });

  test("allow_material_match picks the most-remaining same-type slot", () => {
    const r = resolveRunout(
      ctx("allow_material_match", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: BLUE, type: "PLA", remaining_g: 300 },
        { slot: 2, color: BLUE, type: "PLA", remaining_g: 900 }, // most remaining
      ]),
    );
    expect(r).toMatchObject({ kind: "switch", toSlot: 2 });
  });

  test("allow_material_match never crosses material type", () => {
    const r = resolveRunout(
      ctx("allow_material_match", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: RED, type: "PETG", remaining_g: 900 }, // different type
      ]),
    );
    expect(r).toEqual({ kind: "pending", reason: "no_candidate" });
  });

  test("slots at/below the threshold are not viable candidates (INV-RUNOUT-07)", () => {
    const r = resolveRunout(
      ctx(
        "allow_material_match",
        [
          { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
          { slot: 1, color: BLUE, type: "PLA", remaining_g: 10 }, // == threshold, excluded
        ],
        0,
        10,
      ),
    );
    expect(r).toEqual({ kind: "pending", reason: "no_candidate" });
  });

  test("same-color match is not flagged as a substitution", () => {
    const r = resolveRunout(
      ctx("allow_material_match", [
        { slot: 0, color: RED, type: "PLA", remaining_g: 0 },
        { slot: 1, color: RED, type: "PLA", remaining_g: 800 },
      ]),
    );
    expect(r).toEqual({ kind: "switch", toSlot: 1, substitutedColor: null });
  });
});
